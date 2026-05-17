from __future__ import annotations

from abc import ABC, abstractmethod

from ..types import AIProviderResponse, AIRequest, AIRoute


class AIProvider(ABC):
    @abstractmethod
    def complete(self, request: AIRequest, route: AIRoute) -> AIProviderResponse:
        raise NotImplementedError
