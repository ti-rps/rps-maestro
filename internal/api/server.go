package api

import (
	"fmt"
	"log"

	"github.com/EnzzoHosaki/rps-maestro/internal/api/handlers"
	"github.com/EnzzoHosaki/rps-maestro/internal/api/middleware"
	"github.com/EnzzoHosaki/rps-maestro/internal/config"
	"github.com/EnzzoHosaki/rps-maestro/internal/queue"
	"github.com/EnzzoHosaki/rps-maestro/internal/repository"
	"github.com/EnzzoHosaki/rps-maestro/internal/scheduler"
	"github.com/gin-gonic/gin"
)

type Server struct {
	config         config.ServerConfig
	workerAPIKey   string
	userRepo       repository.UserRepository
	automationRepo repository.AutomationRepository
	jobRepo        repository.JobRepository
	jobLogRepo     repository.JobLogRepository
	scheduleRepo   repository.ScheduleRepository
	queueClient    *queue.RabbitMQClient
	scheduler      *scheduler.Scheduler
	router         *gin.Engine
}

func NewServer(
	cfg config.ServerConfig,
	workerCfg config.WorkerConfig,
	userRepo repository.UserRepository,
	automationRepo repository.AutomationRepository,
	jobRepo repository.JobRepository,
	jobLogRepo repository.JobLogRepository,
	scheduleRepo repository.ScheduleRepository,
	queueClient *queue.RabbitMQClient,
	sched *scheduler.Scheduler,
) *Server {
	router := gin.Default()

	server := &Server{
		config:         cfg,
		workerAPIKey:   workerCfg.APIKey,
		userRepo:       userRepo,
		automationRepo: automationRepo,
		jobRepo:        jobRepo,
		jobLogRepo:     jobLogRepo,
		scheduleRepo:   scheduleRepo,
		queueClient:    queueClient,
		scheduler:      sched,
		router:         router,
	}

	server.setupRoutes()

	return server
}

func (s *Server) setupRoutes() {
	v1 := s.router.Group("/api/v1")
	{
		v1.GET("/health", s.healthCheck)

		// User endpoints
		userHandler := handlers.NewUserHandler(s.userRepo)
		users := v1.Group("/users")
		{
			users.POST("", userHandler.CreateUser)
			users.GET("", userHandler.GetAllUsers)
			users.GET("/email", userHandler.GetUserByEmail)
			users.GET("/:id", userHandler.GetUserByID)
			users.PUT("/:id", userHandler.UpdateUser)
			users.DELETE("/:id", userHandler.DeleteUser)
		}

		automationHandler := handlers.NewAutomationHandler(s.automationRepo, s.jobRepo, s.queueClient)
		automations := v1.Group("/automations")
		{
			automations.POST("", automationHandler.CreateAutomation)
			automations.GET("", automationHandler.GetAllAutomations)
			automations.GET("/:id", automationHandler.GetAutomationByID)
			automations.PUT("/:id", automationHandler.UpdateAutomation)
			automations.DELETE("/:id", automationHandler.DeleteAutomation)
			automations.POST("/:id/execute", automationHandler.ExecuteAutomation)
		}

		jobHandler := handlers.NewJobHandler(s.jobRepo, s.jobLogRepo)
		jobs := v1.Group("/jobs")
		{
			jobs.GET("/:id", jobHandler.GetJobByID)
			jobs.GET("/:id/logs", jobHandler.GetJobLogs)
		}

		scheduleHandler := handlers.NewScheduleHandler(s.scheduleRepo, s.scheduler)
		schedules := v1.Group("/schedules")
		{
			schedules.POST("", scheduleHandler.CreateSchedule)
			schedules.GET("", scheduleHandler.GetAllEnabledSchedules)
			schedules.GET("/:id", scheduleHandler.GetScheduleByID)
			schedules.PUT("/:id", scheduleHandler.UpdateSchedule)
			schedules.DELETE("/:id", scheduleHandler.DeleteSchedule)
		}

		workerHandler := handlers.NewWorkerHandler(s.jobRepo, s.jobLogRepo)
		worker := v1.Group("/worker", middleware.WorkerAPIKey(s.workerAPIKey))
		{
			worker.POST("/jobs/:id/start", workerHandler.HandleJobStart)
			worker.POST("/jobs/:id/log", workerHandler.HandleJobLog)
			worker.POST("/jobs/:id/finish", workerHandler.HandleJobFinish)
		}
	}
}

func (s *Server) Start() {
	addr := fmt.Sprintf(":%d", s.config.Port)
	log.Printf("Iniciando servidor HTTP na porta %s", addr)

	if err := s.router.Run(addr); err != nil {
		log.Fatalf("Não foi possível iniciar o servidor: %v", err)
	}
}

func (s *Server) healthCheck(ctx *gin.Context) {
	ctx.JSON(200, gin.H{
		"status": "ok",
	})
}
