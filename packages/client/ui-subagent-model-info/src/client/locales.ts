/** `subagent-model-info` dictionary namespace. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'subagent-model-info'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'field.model': '模型',
  'field.reasoningEffort': '思考强度',
  'field.agent': '子智能体 ID',
  'field.name': '子智能体名称',
  'field.job': '后台任务 ID',
  'field.task': '委派任务',
  'status.started': '已启动',
  'status.error': '出错',
  'status.reply': '已返回回复',
  'title.subagent': '创建子智能体',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SubagentModelInfoKey, string> = {
  'field.model': 'Model',
  'field.reasoningEffort': 'Reasoning effort',
  'field.agent': 'Subagent ID',
  'field.name': 'Subagent name',
  'field.job': 'Job ID',
  'field.task': 'Delegated task',
  'status.started': 'Started',
  'status.error': 'Error',
  'status.reply': 'Reply received',
  'title.subagent': 'Create subagent',
}

/** Key domain of the `subagent-model-info` namespace. */
export type SubagentModelInfoKey = keyof typeof zh
