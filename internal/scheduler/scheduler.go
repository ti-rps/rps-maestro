package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/EnzzoHosaki/rps-maestro/internal/models"
	"github.com/EnzzoHosaki/rps-maestro/internal/queue"
	"github.com/EnzzoHosaki/rps-maestro/internal/repository"
	"github.com/robfig/cron/v3"
)

type Scheduler struct {
	cron           *cron.Cron
	scheduleRepo   repository.ScheduleRepository
	automationRepo repository.AutomationRepository
	jobRepo        repository.JobRepository
	queueClient    *queue.RabbitMQClient
	entries        map[int]cron.EntryID
	mu             sync.Mutex
}

func New(
	scheduleRepo repository.ScheduleRepository,
	automationRepo repository.AutomationRepository,
	jobRepo repository.JobRepository,
	queueClient *queue.RabbitMQClient,
) *Scheduler {
	return &Scheduler{
		cron:           cron.New(),
		scheduleRepo:   scheduleRepo,
		automationRepo: automationRepo,
		jobRepo:        jobRepo,
		queueClient:    queueClient,
		entries:        make(map[int]cron.EntryID),
	}
}

// Start carrega os agendamentos do banco e inicia o cron runner.
func (s *Scheduler) Start(ctx context.Context) {
	if err := s.Reload(ctx); err != nil {
		log.Printf("[scheduler] erro ao carregar agendamentos iniciais: %v", err)
	}
	s.cron.Start()
	log.Printf("[scheduler] iniciado com %d agendamento(s) ativo(s)", len(s.entries))
}

// Stop encerra o cron runner gracefully.
func (s *Scheduler) Stop() {
	s.cron.Stop()
}

// Reload sincroniza os agendamentos do banco com o cron runner.
// Deve ser chamado após criar, atualizar ou deletar um agendamento via API.
func (s *Scheduler) Reload(ctx context.Context) error {
	schedules, err := s.scheduleRepo.GetAllEnabled(ctx)
	if err != nil {
		return fmt.Errorf("erro ao buscar agendamentos: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	activeIDs := make(map[int]struct{}, len(schedules))
	for _, sc := range schedules {
		activeIDs[sc.ID] = struct{}{}
	}

	// Remove entradas que foram desabilitadas ou deletadas
	for id, entryID := range s.entries {
		if _, ok := activeIDs[id]; !ok {
			s.cron.Remove(entryID)
			delete(s.entries, id)
			log.Printf("[scheduler] agendamento %d removido", id)
		}
	}

	// Registra novos agendamentos
	for _, sc := range schedules {
		if _, exists := s.entries[sc.ID]; exists {
			continue
		}

		scheduleID := sc.ID
		entryID, err := s.cron.AddFunc(sc.CronExpression, func() {
			s.runSchedule(scheduleID)
		})
		if err != nil {
			log.Printf("[scheduler] expressão cron inválida no agendamento %d (%q): %v", sc.ID, sc.CronExpression, err)
			continue
		}
		s.entries[sc.ID] = entryID

		next := s.cron.Entry(entryID).Next
		if err := s.scheduleRepo.UpdateNextRun(ctx, sc.ID, &next); err != nil {
			log.Printf("[scheduler] erro ao atualizar next_run_at do agendamento %d: %v", sc.ID, err)
		}
		log.Printf("[scheduler] agendamento %d registrado (próxima execução: %s)", sc.ID, next.Format("2006-01-02 15:04:05"))
	}

	return nil
}

func (s *Scheduler) runSchedule(scheduleID int) {
	ctx := context.Background()

	sc, err := s.scheduleRepo.GetByID(ctx, scheduleID)
	if err != nil {
		log.Printf("[scheduler] erro ao buscar agendamento %d: %v", scheduleID, err)
		return
	}
	if !sc.IsEnabled {
		return
	}

	automation, err := s.automationRepo.GetByID(ctx, sc.AutomationID)
	if err != nil {
		log.Printf("[scheduler] automação %d não encontrada para agendamento %d: %v", sc.AutomationID, scheduleID, err)
		return
	}

	params, err := parseParams(sc.Parameters)
	if err != nil {
		log.Printf("[scheduler] parâmetros inválidos no agendamento %d: %v", scheduleID, err)
		return
	}

	paramsJSON, err := json.Marshal(params)
	if err != nil {
		log.Printf("[scheduler] erro ao serializar parâmetros do agendamento %d: %v", scheduleID, err)
		return
	}

	job := &models.Job{
		AutomationID: automation.ID,
		Status:       "pending",
		Parameters:   paramsJSON,
	}

	if err := s.jobRepo.Create(ctx, job); err != nil {
		log.Printf("[scheduler] erro ao criar job para agendamento %d: %v", scheduleID, err)
		return
	}

	queueName := automation.QueueName
	if queueName == "" {
		queueName = "automation_jobs"
	}

	msg := queue.JobMessage{
		JobID:        job.ID.String(),
		AutomationID: automation.ID,
		ScriptPath:   automation.ScriptPath,
		Parameters:   params,
	}

	if err := s.queueClient.PublishJob(ctx, queueName, msg); err != nil {
		log.Printf("[scheduler] erro ao enfileirar job para agendamento %d: %v", scheduleID, err)
		return
	}

	// Atualiza next_run_at após disparar
	s.mu.Lock()
	if entryID, ok := s.entries[scheduleID]; ok {
		next := s.cron.Entry(entryID).Next
		if err := s.scheduleRepo.UpdateNextRun(ctx, scheduleID, &next); err != nil {
			log.Printf("[scheduler] erro ao atualizar next_run_at do agendamento %d: %v", scheduleID, err)
		}
	}
	s.mu.Unlock()

	log.Printf("[scheduler] job %s criado — automação %q (agendamento %d)", job.ID, automation.Name, scheduleID)
}

func parseParams(raw json.RawMessage) (map[string]interface{}, error) {
	if len(raw) == 0 {
		return make(map[string]interface{}), nil
	}
	var params map[string]interface{}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, err
	}
	return params, nil
}
