package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/EnzzoHosaki/rps-maestro/internal/api"
	"github.com/EnzzoHosaki/rps-maestro/internal/config"
	"github.com/EnzzoHosaki/rps-maestro/internal/queue"
	"github.com/EnzzoHosaki/rps-maestro/internal/repository"
	"github.com/EnzzoHosaki/rps-maestro/internal/scheduler"
)

func connectWithRetry(cfg config.RabbitMQConfig, maxRetries int, delay time.Duration) (*queue.RabbitMQClient, error) {
	var lastErr error
	for i := 0; i < maxRetries; i++ {
		client, err := queue.NewRabbitMQClient(cfg)
		if err == nil {
			return client, nil
		}
		lastErr = err
		if i < maxRetries-1 {
			log.Printf("Tentativa %d/%d de conectar ao RabbitMQ falhou, tentando novamente em %v...", i+1, maxRetries, delay)
			time.Sleep(delay)
		}
	}
	return nil, lastErr
}

func main() {
	cfg, err := config.LoadConfig("./configs")
	if err != nil {
		log.Fatalf("não foi possível carregar a configuração: %v", err)
	}
	fmt.Println("Configurações carregadas com sucesso.")

	repo, err := repository.NewPostgresRepository(cfg.Database)
	if err != nil {
		log.Fatalf("não foi possível conectar ao banco de dados: %v", err)
	}
	defer repo.Close()
	fmt.Println("Conexão com o PostgreSQL estabelecida com sucesso!")

	queueClient, err := connectWithRetry(cfg.RabbitMQ, 10, 3*time.Second)
	if err != nil {
		log.Fatalf("não foi possível conectar ao RabbitMQ após 10 tentativas: %v", err)
	}
	defer queueClient.Close()
	fmt.Println("Conexão com o RabbitMQ estabelecida com sucesso!")

	userRepo := repo.GetUserRepository()
	automationRepo := repo.GetAutomationRepository()
	jobRepo := repo.GetJobRepository()
	jobLogRepo := repo.GetJobLogRepository()
	scheduleRepo := repo.GetScheduleRepository()

	sched := scheduler.New(scheduleRepo, automationRepo, jobRepo, queueClient)
	sched.Start(context.Background())
	defer sched.Stop()

	server := api.NewServer(cfg.Server, cfg.Worker, userRepo, automationRepo, jobRepo, jobLogRepo, scheduleRepo, queueClient, sched)

	server.Start()
}
