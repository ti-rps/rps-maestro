// Local: rps-maestro/internal/models/models.go
package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid" 
)

type User struct {
	ID           int       `db:"id" json:"id"` 
	Name         string    `db:"name" json:"name"`
	Email        string    `db:"email" json:"email"`
	PasswordHash string    `db:"password_hash" json:"-"`
	Role         string    `db:"role" json:"role"`
	CreatedAt    time.Time `db:"created_at" json:"createdAt"`
	UpdatedAt    time.Time `db:"updated_at" json:"updatedAt"`
}

type Automation struct {
	ID              int             `db:"id" json:"id"`
	Name            string          `db:"name" json:"name"`
	Description     *string         `db:"description" json:"description,omitempty"`
	ScriptPath      string          `db:"script_path" json:"scriptPath"`
	QueueName       string          `db:"queue_name" json:"queueName"`
	DefaultParams   json.RawMessage `db:"default_params" json:"defaultParams,omitempty"`
	ParameterSchema json.RawMessage `db:"parameter_schema" json:"parameterSchema,omitempty"`
	CreatedAt       time.Time       `db:"created_at" json:"createdAt"`
	UpdatedAt       time.Time       `db:"updated_at" json:"updatedAt"`
}

type Job struct {
	ID           uuid.UUID       `db:"id" json:"id"`
	AutomationID int             `db:"automation_id" json:"automationId"`
	UserID       *int            `db:"user_id" json:"userId,omitempty"` 
	Status       string          `db:"status" json:"status"`
	Parameters   json.RawMessage `db:"parameters" json:"parameters,omitempty"`
	Result       json.RawMessage `db:"result" json:"result,omitempty"`
	StartedAt    *time.Time      `db:"started_at" json:"startedAt,omitempty"`
	CompletedAt  *time.Time      `db:"completed_at" json:"completedAt,omitempty"`
	CreatedAt    time.Time       `db:"created_at" json:"createdAt"`
}

type JobLog struct {
	ID        int64     `db:"id" json:"id"`
	JobID     uuid.UUID `db:"job_id" json:"jobId"`
	Timestamp time.Time `db:"timestamp" json:"timestamp"`
	Level     string    `db:"level" json:"level"`
	Message   string    `db:"message" json:"message"`
}

type Schedule struct {
	ID             int             `db:"id" json:"id"`
	AutomationID   int             `db:"automation_id" json:"automationId"`
	CronExpression string          `db:"cron_expression" json:"cronExpression"`
	Parameters     json.RawMessage `db:"parameters" json:"parameters,omitempty"`
	NextRunAt      *time.Time      `db:"next_run_at" json:"nextRunAt,omitempty"`
	IsEnabled      bool            `db:"is_enabled" json:"isEnabled"`
	CreatedAt      time.Time       `db:"created_at" json:"createdAt"`
	UpdatedAt      time.Time       `db:"updated_at" json:"updatedAt"`
}