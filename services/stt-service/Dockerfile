FROM python:3.12-slim

WORKDIR /app

COPY services/stt-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY proto/ ./proto/
COPY services/stt-service/src/ ./src/

EXPOSE 50056
CMD ["python", "src/server.py"]
