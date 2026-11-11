FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY transcriber transcriber
# The model is downloaded on first start into /models (a named volume in docker-compose.yml).
RUN useradd --create-home relay && mkdir -p /models && chown relay /models
ENV TRANSCRIBER_HOST=0.0.0.0 TRANSCRIBER_PORT=8000 HF_HOME=/models PYTHONUNBUFFERED=1
USER relay
EXPOSE 8000
CMD ["python", "-m", "transcriber"]
