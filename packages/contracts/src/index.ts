export type EntityType = 'event' | 'session' | 'category'
export type OperationAction = 'upsert' | 'delete'

export interface SyncOperation {
  operationId: string
  entityType: EntityType
  entityId: string
  action: OperationAction
  baseVersion: number
  payload?: Record<string, unknown>
  clientUpdatedAt: string
}

export interface PushRequest {
  deviceId: string
  operations: SyncOperation[]
}

export interface PullResponse {
  cursor: string
  operations: SyncOperation[]
}
