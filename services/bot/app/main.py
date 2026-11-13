from fastapi import FastAPI

SERVICE_NAME = "bot"


def create_app() -> FastAPI:
    app = FastAPI(title="Banking assistant bot")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE_NAME}

    return app


app = create_app()
