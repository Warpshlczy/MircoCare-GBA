"""API layer (FastAPI routers)."""

from .contract_routes import router as contract_router
from .insight_routes import router as insight_router

__all__ = ["contract_router", "insight_router"]