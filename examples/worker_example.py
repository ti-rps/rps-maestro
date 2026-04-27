"""
Exemplo de worker Python para integração com o RPS Maestro.

O worker:
1. Consome mensagens da fila RabbitMQ
2. Executa a automação
3. Reporta progresso e resultado ao Maestro via HTTP

Variáveis de ambiente necessárias:
  MAESTRO_URL         - URL base do Maestro (ex: http://maestro-backend:8000)
  MAESTRO_WORKER_API_KEY - Chave de autenticação (deve ser igual ao valor
                           configurado no Maestro via MAESTRO_WORKER_API_KEY)
  RABBITMQ_URL        - URL do RabbitMQ (ex: amqp://guest:guest@rabbitmq:5672/)
  QUEUE_NAME          - Nome da fila a consumir (ex: bot_xml_gms)
"""

import json
import os
import time

import pika
import requests

MAESTRO_URL = os.environ.get("MAESTRO_URL", "http://maestro-backend:8000")
WORKER_API_KEY = os.environ.get("MAESTRO_WORKER_API_KEY", "")
RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
QUEUE_NAME = os.environ.get("QUEUE_NAME", "automation_jobs")


def maestro_headers() -> dict:
    """Retorna os headers HTTP necessários para a Worker API do Maestro."""
    headers = {"Content-Type": "application/json"}
    if WORKER_API_KEY:
        headers["X-Worker-API-Key"] = WORKER_API_KEY
    return headers


def report_start(job_id: str) -> None:
    url = f"{MAESTRO_URL}/api/v1/worker/jobs/{job_id}/start"
    resp = requests.post(url, headers=maestro_headers(), timeout=10)
    resp.raise_for_status()


def report_log(job_id: str, level: str, message: str) -> None:
    url = f"{MAESTRO_URL}/api/v1/worker/jobs/{job_id}/log"
    resp = requests.post(
        url,
        headers=maestro_headers(),
        json={"level": level, "message": message},
        timeout=10,
    )
    resp.raise_for_status()


def report_finish(job_id: str, status: str, result: dict | None = None) -> None:
    """
    status: "completed" | "completed_no_invoices" | "failed" | "canceled"
    """
    url = f"{MAESTRO_URL}/api/v1/worker/jobs/{job_id}/finish"
    payload = {"status": status}
    if result:
        payload["result"] = result
    resp = requests.post(url, headers=maestro_headers(), json=payload, timeout=10)
    resp.raise_for_status()


def execute_automation(parameters: dict) -> dict:
    """
    Implemente aqui a lógica da automação.
    Recebe os parâmetros configurados no agendamento e retorna o resultado.
    """
    days_back = parameters.get("days_back", 2)
    document_types = parameters.get("document_types", ["nfe"])

    # Exemplo: bot-xml-gms baixa XMLs dos últimos N dias
    print(f"Baixando {document_types} dos últimos {days_back} dias...")
    time.sleep(2)  # simulação de trabalho

    return {"downloaded": 42, "days_back": days_back, "types": document_types}


def process_message(channel, method, _properties, body: bytes) -> None:
    message = json.loads(body)
    job_id = message["job_id"]
    parameters = message.get("parameters", {})

    print(f"[{job_id}] Iniciando job...")

    try:
        report_start(job_id)
        report_log(job_id, "INFO", "Worker iniciado")

        result = execute_automation(parameters)

        report_log(job_id, "INFO", f"Concluído: {result}")
        report_finish(job_id, "completed", result)
        print(f"[{job_id}] Concluído com sucesso.")

    except Exception as exc:
        print(f"[{job_id}] Erro: {exc}")
        try:
            report_log(job_id, "ERROR", str(exc))
            report_finish(job_id, "failed", {"error": str(exc)})
        except Exception:
            pass  # Maestro pode estar fora do ar

    finally:
        channel.basic_ack(delivery_tag=method.delivery_tag)


def main() -> None:
    print(f"Conectando ao RabbitMQ: {RABBITMQ_URL}")
    params = pika.URLParameters(RABBITMQ_URL)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()

    channel.queue_declare(queue=QUEUE_NAME, durable=True)
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue=QUEUE_NAME, on_message_callback=process_message)

    print(f"Aguardando jobs na fila '{QUEUE_NAME}'...")
    channel.start_consuming()


if __name__ == "__main__":
    main()
