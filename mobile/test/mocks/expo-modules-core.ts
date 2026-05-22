export function requireNativeModule(_moduleName: string) {
  return null;
}

export class EventEmitter {
  constructor(_nativeModule?: unknown) {}

  addListener(_eventName: string, _listener: (...args: any[]) => void) {
    return {
      remove: () => undefined,
    };
  }
}

export default {
  EventEmitter,
  requireNativeModule,
};
