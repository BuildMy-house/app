FROM python:3.12-slim

WORKDIR /app
ENV PYTHONPATH=/app

RUN pip install --no-cache-dir \
    pyluxcore==2.11.0 \
    numpy pillow pydantic

COPY luxcore ./luxcore
COPY public/assets/models/sh3d ./homely/assets/models/sh3d

RUN python -m py_compile luxcore/*.py

EXPOSE 8081
CMD ["python", "-m", "luxcore.worker"]
