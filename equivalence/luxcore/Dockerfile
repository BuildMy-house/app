FROM python:3.12-slim

WORKDIR /app
ENV PYTHONPATH=/app

RUN pip install --no-cache-dir \
    pyluxcore==2.11.0 \
    numpy pillow pydantic

COPY equivalence/luxcore ./equivalence/luxcore
COPY buildmyhouse/assets/models/sh3d ./homely/assets/models/sh3d

RUN python -m py_compile equivalence/luxcore/*.py

EXPOSE 8081
CMD ["python", "-m", "equivalence.luxcore.worker"]
