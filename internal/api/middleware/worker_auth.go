package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// WorkerAPIKey protege os endpoints de callback dos workers.
// Se a chave estiver vazia (dev local), a requisição passa sem validação.
func WorkerAPIKey(apiKey string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if apiKey == "" {
			c.Next()
			return
		}
		if c.GetHeader("X-Worker-API-Key") != apiKey {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "API key inválida"})
			return
		}
		c.Next()
	}
}
