// RAG 控制台与进程管理器共用的常量（避免 rag-control ↔ process-manager 循环 import）。
export const MEMORY_RAG_UNIT = 'qq-memory-rag';
export const EMBEDDING_UNIT = 'qq-embedding';

export const STEP = Object.freeze({
  startEmbedding: '正在启动向量模型（qq-embedding）…',
  startRag: '正在启动 memory-rag…',
  wait: '正在等待服务就绪…',
  stop: '正在停止…'
});
