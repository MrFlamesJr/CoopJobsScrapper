FROM python:3.12-slim

WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY database ./database
COPY server/app.py ./server_app.py

EXPOSE 8000

CMD ["python", "server_app.py"]
