# Drawbridge intake OCR: Tesseract 5 (English, fast + best models) + poppler, fax-image preprocessing,
# a second pass over the patient header lines, sender templates. Local only.
#
# Documents are PHI: this container makes no outbound calls and is reached only on the internal
# `drawbridge` Docker network (no published ports). See deploy/ocr/README.md.
#
#   docker build -t drawbridge-intake-ocr deploy/ocr
#   docker run --rm --network none -v <in>:/in:ro -v <out>:/out drawbridge-intake-ocr batch /in /out
FROM python:3.12-slim

# Debian (python:3.12-slim = trixie): tesseract-ocr 5.5.x, poppler-utils (pdftotext, pdftoppm, pdfinfo)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pillow==11.0.0 numpy==2.1.3 opencv-python-headless==4.10.0.84

# tessdata_best English LSTM model (15 MB, tag 4.1.0), pinned by checksum and baked in: the container
# never downloads anything at run time. The header pass reads with it next to Debian's tessdata_fast.
ADD --chmod=644 --checksum=sha256:8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba \
    https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/eng.traineddata /usr/share/tesseract-ocr/5/tessdata/eng_best.traineddata

RUN useradd --system --uid 10001 --home-dir /app ocr && mkdir -p /app && chown ocr /app
WORKDIR /app
COPY ocr_service.py /app/ocr_service.py
# Sender templates (where a sender's patient header sits); more can be mounted at OCR_TEMPLATES_DIR.
COPY templates /app/templates

USER ocr
# One Tesseract thread per job; concurrency comes from OCR_CONCURRENCY / --workers.
ENV OMP_THREAD_LIMIT=1 \
    PYTHONUNBUFFERED=1 \
    OCR_PORT=8090 \
    OCR_CONCURRENCY=2
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4).status == 200 else 1)"
ENTRYPOINT ["python", "/app/ocr_service.py"]
CMD ["serve"]
