export type ModelType = 'wan-2.2-t2v' | 'wan-2.2-i2v' | 'wan-2.2-fast' | 'custom';
export type VideoMode = 'text-to-video' | 'image-to-video';
export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type AspectRatio = '16:9' | '9:16' | '1:1';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationJob {
  id: string;
  projectId?: string;
  provider: 'wan22' | 'huggingface' | 'development';
  model: ModelType;
  mode: VideoMode;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  duration: number;
  resolution: string;
  status: GenerationStatus;
  progress: number;
  providerJobId?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  outputUrl?: string;
}

export interface AuthFormState {
  email: string;
  password: string;
  fullName?: string;
}
