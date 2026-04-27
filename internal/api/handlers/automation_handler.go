package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"github.com/EnzzoHosaki/rps-maestro/internal/models"
	"github.com/EnzzoHosaki/rps-maestro/internal/queue"
	"github.com/EnzzoHosaki/rps-maestro/internal/repository"
	"github.com/gin-gonic/gin"
)

type AutomationHandler struct {
	automationRepo repository.AutomationRepository
	jobRepo        repository.JobRepository
	queueClient    *queue.RabbitMQClient
}

func NewAutomationHandler(
	automationRepo repository.AutomationRepository,
	jobRepo repository.JobRepository,
	queueClient *queue.RabbitMQClient,
) *AutomationHandler {
	return &AutomationHandler{
		automationRepo: automationRepo,
		jobRepo:        jobRepo,
		queueClient:    queueClient,
	}
}

func (h *AutomationHandler) CreateAutomation(c *gin.Context) {
	var automation models.Automation
	
	if err := c.ShouldBindJSON(&automation); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos: " + err.Error()})
		return
	}

	if err := h.automationRepo.Create(c.Request.Context(), &automation); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar automação: " + err.Error()})
		return
	}

	c.JSON(http.StatusCreated, automation)
}

func (h *AutomationHandler) GetAutomationByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	automation, err := h.automationRepo.GetByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Automação não encontrada"})
		return
	}

	c.JSON(http.StatusOK, automation)
}

func (h *AutomationHandler) GetAllAutomations(c *gin.Context) {
	automations, err := h.automationRepo.GetAll(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar automações: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, automations)
}

func (h *AutomationHandler) UpdateAutomation(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	var automation models.Automation
	if err := c.ShouldBindJSON(&automation); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos: " + err.Error()})
		return
	}

	automation.ID = id
	if err := h.automationRepo.Update(c.Request.Context(), &automation); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar automação: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, automation)
}

func (h *AutomationHandler) DeleteAutomation(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	if err := h.automationRepo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao deletar automação: " + err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

func (h *AutomationHandler) ExecuteAutomation(c *gin.Context) {
	idParam := c.Param("id")
	automationID, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	automation, err := h.automationRepo.GetByID(c.Request.Context(), automationID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Automação não encontrada"})
		return
	}

	var params map[string]interface{}
	if err := c.ShouldBindJSON(&params); err != nil {
		params = make(map[string]interface{})
	}

	paramsJSON, err := json.Marshal(params)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Erro ao processar parâmetros: " + err.Error()})
		return
	}

	job := &models.Job{
		AutomationID: automationID,
		Status:       "pending",
		Parameters:   paramsJSON,
	}

	if err := h.jobRepo.Create(c.Request.Context(), job); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar job: " + err.Error()})
		return
	}

	queueMsg := queue.JobMessage{
		JobID:        job.ID.String(),
		AutomationID: automationID,
		ScriptPath:   automation.ScriptPath,
		Parameters:   params,
	}

	queueName := automation.QueueName
	if queueName == "" {
		queueName = "automation_jobs"
	}

	if err := h.queueClient.PublishJob(c.Request.Context(), queueName, queueMsg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao enfileirar job: " + err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, job)
}
