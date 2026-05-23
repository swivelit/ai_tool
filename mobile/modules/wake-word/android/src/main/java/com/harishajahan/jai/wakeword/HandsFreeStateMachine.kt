package com.harishajahan.jai.wakeword

enum class HandsFreeNativeState(val wireName: String) {
  IDLE("idle"),
  WAKE_LISTENING("wakeListening"),
  WAKE_DETECTED("wakeDetected"),
  COMMAND_LISTENING("commandListening"),
  COMMAND_READY("commandReady"),
  SUBMITTING("submitting"),
  SPEAKING("speaking"),
}

data class HandsFreeStateEvent(
  val state: HandsFreeNativeState,
  val previousState: HandsFreeNativeState,
  val reason: String,
  val timestamp: Long = System.currentTimeMillis(),
)

class HandsFreeStateMachine {
  private var state = HandsFreeNativeState.IDLE

  @Synchronized
  fun currentState(): HandsFreeNativeState = state

  @Synchronized
  fun transition(nextState: HandsFreeNativeState, reason: String): HandsFreeStateEvent {
    val previous = state
    state = nextState
    return HandsFreeStateEvent(
      state = nextState,
      previousState = previous,
      reason = reason,
    )
  }
}
