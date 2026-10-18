# Drawbridge voice-gw: SIP user agent (registers as a PBX extension over TLS) + G.711/SRTP media gateway.
# Pinned by digest. Static Go binary on distroless (no shell, non-root).
FROM golang:1.25.3-alpine3.22@sha256:aee43c3ccbf24fdffb7295693b6e33b21e01baec1b2a55acc351fde345e9ec34 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY *.go ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/voice-gw .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
WORKDIR /app
COPY --from=build /out/voice-gw /app/voice-gw
COPY clips/ /app/clips/
USER nonroot:nonroot
ENV VOICE_GW_STATUS_FILE=/tmp/voice-gw-status.json
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["/app/voice-gw", "-healthcheck"]
ENTRYPOINT ["/app/voice-gw"]
