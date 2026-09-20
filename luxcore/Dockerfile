FROM python:3.12-slim

WORKDIR /app
ENV PYTHONPATH=/app
ENV LUXCORE_ASSET_ROOT=/app/homely/assets/models/sh3d

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    pyluxcore==2.11.0 \
    numpy pillow pydantic

COPY luxcore ./luxcore
COPY public/assets/models/sh3d ./homely/assets/models/sh3d

RUN python -m py_compile luxcore/*.py

EXPOSE 8081
CMD ["python", "-m", "luxcore.worker"]
