# Synthetic document generator for the intake test bench. Runs offline once built.
#
#   docker build -t drawbridge-intake-synth tools/intake-synth
#   docker run --rm --network none -v <out>:/out drawbridge-intake-synth generate --roster 300 --docs 1000 --seed 42 --out /out/set-s42
FROM python:3.12-slim
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && useradd --system --uid 10001 synth
WORKDIR /app
COPY generate.py /app/
COPY synth /app/synth
USER synth
ENTRYPOINT ["python", "/app/generate.py"]
