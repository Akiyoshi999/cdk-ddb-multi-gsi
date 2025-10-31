import type { GSIOperationState, GSIOperation } from "../../../lib/types/index.js";

/**
 * 操作状態をJSON文字列にシリアライズ
 */
export function serializeOperationState(state: GSIOperationState): string {
  return JSON.stringify(state);
}

/**
 * JSON文字列から操作状態をデシリアライズ
 */
export function deserializeOperationState(json: string): GSIOperationState {
  return JSON.parse(json);
}

/**
 * 新しい操作状態を作成
 */
export function createInitialState(operations: GSIOperation[]): GSIOperationState {
  return {
    allOperations: operations,
    completedIndices: [],
    currentIndex: operations.length > 0 ? 0 : -1,
    startTime: new Date().toISOString(),
  };
}

/**
 * 現在の操作が完了したことをマーク
 */
export function markCurrentOperationComplete(state: GSIOperationState): GSIOperationState {
  if (state.currentIndex === -1) {
    return state;
  }

  const newCompletedIndices = [...state.completedIndices, state.currentIndex];
  const nextIndex = state.currentIndex + 1;

  return {
    ...state,
    completedIndices: newCompletedIndices,
    currentIndex: nextIndex < state.allOperations.length ? nextIndex : -1,
  };
}

/**
 * すべての操作が完了したか判定
 */
export function isAllOperationsComplete(state: GSIOperationState): boolean {
  return state.currentIndex === -1 && state.allOperations.length === state.completedIndices.length;
}

/**
 * 現在実行中の操作を取得
 */
export function getCurrentOperation(state: GSIOperationState): GSIOperation | null {
  if (state.currentIndex === -1 || state.currentIndex >= state.allOperations.length) {
    return null;
  }
  return state.allOperations[state.currentIndex];
}
