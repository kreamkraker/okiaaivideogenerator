import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  Clock3,
  CreditCard,
  Download,
  Film,
  Folder,
  LayoutDashboard,
  LogOut,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Upload,
  User,
  Video,
} from 'lucide-react';
import { supabase } from './lib/supabase';
import { advanceGenerationStatus, submitVideoJob, type VideoGenerationInput } from './lib/provider';
import type { GenerationJob, ProjectRecord } from './types';

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard },
  { label: 'Create Video', icon: Sparkles },
  { label: 'My Projects', icon: Folder },
  { label: 'Video Library', icon: Video },
  { label: 'Generation History', icon: Clock3 },
  { label: 'Account and Settings', icon: Settings },
  { label: 'Help and Documentation', icon: User },
];

const initialProjects: ProjectRecord[] = [
  { id: 'p-1', name: 'Sunset drone promo', description: 'Brand film concept', prompt: 'A dramatic drone shot across a warm sunset.', createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:00:00Z' },
  { id: 'p-2', name: 'Product teaser', description: 'Short motion ad', prompt: 'Close-up macro product reveal with neon aesthetic.', createdAt: '2026-10-27T14:00:00Z', updatedAt: '2026-10-27T14:00:00Z' },
];

const sampleJobs: GenerationJob[] = [
  {
    id: 'job-1',
    provider: 'development',
    model: 'wan-2.2-t2v',
    mode: 'text-to-video',
    prompt: 'A luxury car accelerating through a futuristic city at dusk.',
    aspectRatio: '16:9',
    duration: 8,
    resolution: '1280x720',
    status: 'completed',
    progress: 100,
    createdAt: '2026-10-28T13:42:00Z',
    completedAt: '2026-10-28T13:51:12Z',
    outputUrl: 'https://example.com/demo/output.mp4',
  },
  {
    id: 'job-2',
    provider: 'development',
    model: 'wan-2.2-i2v',
    mode: 'image-to-video',
    prompt: 'Animate this portrait into a subtle cinematic motion shot.',
    aspectRatio: '9:16',
    duration: 6,
    resolution: '720x1280',
    status: 'processing',
    progress: 74,
    createdAt: '2026-10-28T15:10:00Z',
  },
];

function App() {
  const [session, setSession] = useState<any>(null);
  const [authReady, setAuthReady] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>(initialProjects);
  const [jobs, setJobs] = useState<GenerationJob[]>(sampleJobs);
  const [prompt, setPrompt] = useState('A cinematic aerial shot of a mountain lake at sunrise with soft clouds and reflective water.');
  const [negativePrompt, setNegativePrompt] = useState('blurry, watermark, distorted hands, low detail');
  const [mode, setMode] = useState<'text-to-video' | 'image-to-video'>('text-to-video');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [duration, setDuration] = useState(8);
  const [resolution, setResolution] = useState('1280x720');
  const [model, setModel] = useState<'wan-2.2-t2v' | 'wan-2.2-i2v' | 'wan-2.2-fast' | 'custom'>('wan-2.2-t2v');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const loadSession = async () => {
      if (!supabase) {
        setAuthReady(true);
        return;
      }

      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setAuthReady(true);

      const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        setSession(nextSession);
      });

      return () => listener.subscription.unsubscribe();
    };

    loadSession();
  }, []);

  const dashboardStats = useMemo(
    () => [
      { label: 'Projects', value: String(projects.length) },
      { label: 'Generations', value: String(jobs.length) },
      { label: 'Usage', value: '14.2h' },
      { label: 'Storage', value: '2.8 GB' },
    ],
    [jobs.length, projects.length],
  );

  const handleGenerate = async () => {
    const input: VideoGenerationInput = {
      mode,
      model,
      prompt,
      negativePrompt,
      aspectRatio,
      duration,
      resolution,
      imageFileName: selectedImage ?? undefined,
    };

    setIsSubmitting(true);
    setStatusMessage('');

    const result = await submitVideoJob(input);

    if (!result.ok) {
      setStatusMessage(result.message || 'Generation could not start.');
      setIsSubmitting(false);
      return;
    }

    const newJob: GenerationJob = {
      id: result.providerJobId || `job-${Date.now()}`,
      provider: 'development',
      model,
      mode,
      prompt,
      negativePrompt,
      aspectRatio,
      duration,
      resolution,
      status: result.status,
      progress: result.progress || 0,
      providerJobId: result.providerJobId,
      createdAt: new Date().toISOString(),
      outputUrl: result.outputUrl,
    };

    setJobs((current) => [newJob, ...current]);
    setStatusMessage(result.message);
    setIsSubmitting(false);
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setStatusMessage('Unsupported image type. Use PNG, JPG, or WEBP.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setStatusMessage('Image is too large. Please keep files under 10 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setSelectedImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  if (!authReady) {
    return <div className="loading-shell">Loading Okia workspace…</div>;
  }

  if (!session && supabase) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-block">
            <div className="brand-mark">O</div>
            <div>
              <p className="eyebrow">AI VIDEO GENERATOR</p>
              <h1>Okia</h1>
            </div>
          </div>
          <p className="auth-copy">Sign in to access your video projects, credits, and generation history.</p>
          <button className="primary-button" type="button" onClick={() => setSession({ user: { id: 'demo-user' } })}>
            Continue as demo user
          </button>
          <p className="small-note">Supabase Auth is wired for real login, and the demo path is only for local development.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <div className="brand-mark">O</div>
          <div>
            <p className="eyebrow">AI STUDIO</p>
            <h2>Okia</h2>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${label === 'Create Video' ? 'active' : ''}`} type="button">
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-card">
          <div className="sidebar-topline">
            <Sparkles size={16} />
            <span>Generation queue</span>
          </div>
          <strong>{jobs.filter((job) => job.status !== 'completed').length}</strong>
          <small>active jobs</small>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="search-panel">
            <Search size={18} />
            <input placeholder="Search projects, videos, prompts..." aria-label="Search" />
          </div>

          <div className="topbar-actions">
            <div className="avatar-badge">
              <User size={16} />
            </div>
            <button className="ghost-button" type="button">
              <CreditCard size={16} />
              120 credits
            </button>
            <button className="ghost-button danger" type="button" onClick={() => setSession(null)}>
              <LogOut size={16} />
              Logout
            </button>
          </div>
        </header>

        <section className="overview-grid">
          {dashboardStats.map((stat) => (
            <article key={stat.label} className="stat-card">
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </article>
          ))}
        </section>

        <section className="content-grid">
          <div className="workspace-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">CREATE VIDEO</p>
                <h3>Creative workspace</h3>
              </div>
              <button className="secondary-button" type="button">
                <Plus size={16} />
                New project
              </button>
            </div>

            <div className="mode-row">
              {(['text-to-video', 'image-to-video'] as const).map((option) => (
                <button
                  key={option}
                  className={`segmented ${mode === option ? 'selected' : ''}`}
                  type="button"
                  onClick={() => setMode(option)}
                >
                  {option === 'text-to-video' ? 'Text to video' : 'Image to video'}
                </button>
              ))}
            </div>

            <label className="field-label">
              Prompt
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={5}
                placeholder="Describe the video you want to generate"
              />
            </label>

            <div className="dual-grid">
              <label className="field-label">
                Negative prompt
                <textarea
                  value={negativePrompt}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                  rows={3}
                  placeholder="Avoid common artifacts"
                />
              </label>

              <div className="upload-panel">
                <label className="upload-box">
                  <Upload size={18} />
                  <span>{selectedImage ? 'Image ready for upload' : 'Upload reference image'}</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} />
                </label>
                {selectedImage && <img src={selectedImage} alt="Reference preview" className="preview-image" />}
              </div>
            </div>

            <div className="settings-grid">
              <label className="field-label">
                Model
                <select value={model} onChange={(event) => setModel(event.target.value as any)}>
                  <option value="wan-2.2-t2v">Wan 2.2 Text-to-Video</option>
                  <option value="wan-2.2-i2v">Wan 2.2 Image-to-Video</option>
                  <option value="wan-2.2-fast">Wan 2.2 Fast</option>
                  <option value="custom">Custom provider</option>
                </select>
              </label>

              <label className="field-label">
                Aspect ratio
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as '16:9' | '9:16' | '1:1')}>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </label>

              <label className="field-label">
                Duration (seconds)
                <input type="number" min={4} max={30} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
              </label>

              <label className="field-label">
                Resolution
                <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                  <option value="1280x720">1280x720</option>
                  <option value="720x1280">720x1280</option>
                  <option value="1024x1024">1024x1024</option>
                </select>
              </label>
            </div>

            <div className="action-row">
              <button className="primary-button" type="button" onClick={handleGenerate} disabled={isSubmitting}>
                {isSubmitting ? 'Generating…' : 'Generate Video'}
              </button>
              <span className="status-inline">
                {statusMessage ? <AlertCircle size={15} /> : <Film size={15} />}
                {statusMessage || 'Development adapter active — no GPU credentials configured yet.'}
              </span>
            </div>
          </div>

          <aside className="history-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">HISTORY</p>
                <h3>Recent jobs</h3>
              </div>
              <button className="icon-button" type="button" aria-label="Open history">
                <ChevronDown size={16} />
              </button>
            </div>

            <div className="job-list">
              {jobs.slice(0, 4).map((job) => (
                <article key={job.id} className="job-card">
                  <div className="job-topline">
                    <span className={`job-pill ${job.status}`}>{job.status}</span>
                    <span>{job.mode}</span>
                  </div>
                  <strong>{job.prompt.slice(0, 42)}...</strong>
                  <div className="job-meta">
                    <span>{job.model}</span>
                    <span>{job.aspectRatio}</span>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                  <div className="job-actions">
                    {job.outputUrl ? (
                      <>
                        <button className="tiny-button" type="button">
                          <Play size={14} />
                          Preview
                        </button>
                        <button className="tiny-button" type="button">
                          <Download size={14} />
                          Download
                        </button>
                      </>
                    ) : (
                      <button className="tiny-button" type="button">
                        <ArrowRight size={14} />
                        View status
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </section>

        <section className="bottom-grid">
          <div className="mini-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">PROJECTS</p>
                <h3>Recent library</h3>
              </div>
            </div>
            <div className="project-list">
              {projects.map((project) => (
                <div key={project.id} className="project-row">
                  <div>
                    <strong>{project.name}</strong>
                    <small>{project.description}</small>
                  </div>
                  <button className="tiny-button" type="button">Open</button>
                </div>
              ))}
            </div>
          </div>

          <div className="mini-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">USAGE</p>
                <h3>Credits & tracking</h3>
              </div>
            </div>
            <div className="usage-box">
              <div>
                <span>Monthly usage</span>
                <strong>34%</strong>
              </div>
              <div>
                <span>Available credits</span>
                <strong>120</strong>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
