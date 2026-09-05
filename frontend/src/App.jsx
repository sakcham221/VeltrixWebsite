import { useMemo, useState } from 'react';
import AdSlot from './components/AdSlot';
import { analyzeUrl, requestDownload } from './api';

const sourceOptions = ['youtube', 'instagram'];

function App() {
  const [source, setSource] = useState('youtube');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');

  const formattedOptions = useMemo(() => {
    if (!job?.result?.formats) return [];
    return job.result.formats.map((format) => ({
      ...format,
      active: selectedFormat ? format.id === selectedFormat : format.id === job.result.formats[0].id,
    }));
  }, [job, selectedFormat]);

  async function handleAnalyze() {
    setLoading(true);
    setError('');
    setDownloadUrl('');

    try {
      const data = await analyzeUrl(url, source);
      setJob(data);
      setSelectedFormat(data.result.formats[0].id);
    } catch (err) {
      setError(err.message);
      setJob(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload() {
    if (!job || !selectedFormat) return;

    setLoading(true);
    setError('');

    try {
      const data = await requestDownload(job.jobId, selectedFormat);
      setDownloadUrl(data.downloadUrl);

      const link = document.createElement('a');
      link.href = data.downloadUrl;
      link.download = data.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(err.message || 'Download is not available in this demo build.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-container">
        <aside className="ad-rail ad-rail--left" aria-label="Left advertisement column">
          <AdSlot position="left" size="desktop" />
        </aside>

        <main className="main-content">
          <header className="topbar">
            <div className="brand-wrap">
              <div className="brand-mark">V</div>
              <div>
                <div className="brand-name">Veltrix Softwares</div>
              </div>
            </div>
            <nav className="nav" aria-label="Main navigation">
              <a href="#features">Features</a>
              <a href="#how-it-works">How it Works</a>
              <a href="#faq">FAQ</a>
            </nav>
          </header>

          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">Free and instant</span>
              <h1>Download Videos &amp; Reels Easily</h1>
              <p>
                Paste a supported URL and get your download options in seconds without creating an account.
              </p>
            </div>
            <div className="hero-badge">No login required</div>
          </section>

          <div className="mobile-only-ad">
            <AdSlot position="top" size="responsive" />
          </div>

          <section className="downloader-card" aria-label="Downloader section">
            <div className="picker-row">
              {sourceOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`source-button ${source === option ? 'active' : ''}`}
                  onClick={() => setSource(option)}
                >
                  {option === 'youtube' ? 'YouTube' : 'Instagram'}
                </button>
              ))}
            </div>

            <label htmlFor="media-url" className="sr-only">Media URL</label>
            <div className="input-row">
              <input
                id="media-url"
                type="url"
                placeholder="Paste video or reel URL"
                aria-label="Paste video or reel URL"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <button type="button" className="primary-button" onClick={handleAnalyze} disabled={loading || !url.trim()}>
                {loading ? 'Analyzing...' : 'Get Download Options'}
              </button>
            </div>

            {error && <div className="status-message error">{error}</div>}

            {job && (
              <>
                <div className="result-card" aria-live="polite">
                  <div className="result-thumb" aria-hidden="true" style={{ backgroundImage: `url(${job.result.thumbnail})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                  <div className="result-meta">
                    <h2>{job.result.title}</h2>
                    <div className="meta-line">
                      <span>Duration: {job.result.duration}</span>
                      <span>Thumbnail: Ready</span>
                    </div>
                  </div>
                </div>

                <div className="formats-block">
                  <h3>Available Formats</h3>
                  <div className="format-list">
                    {formattedOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`format-item ${option.active ? 'selected' : ''}`}
                        onClick={() => setSelectedFormat(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button type="button" className="download-button" onClick={handleDownload} disabled={loading}>
                  {loading ? 'Processing...' : 'Download'}
                </button>

                {downloadUrl && <div className="status-message success">Temporary download ready. It will expire automatically.</div>}
              </>
            )}
          </section>

          <div className="responsive-ad-wrap">
            <AdSlot position="inline" size="responsive" />
          </div>

          <section className="info-section" id="how-it-works">
            <div className="section-header">
              <span className="eyebrow">Simple flow</span>
              <h2>How It Works</h2>
            </div>
            <div className="steps-grid">
              <div className="step-card">
                <span>1</span>
                <h3>Paste URL</h3>
                <p>Copy the video or reel link from supported sites.</p>
              </div>
              <div className="step-card">
                <span>2</span>
                <h3>Analyze</h3>
                <p>We validate the URL and inspect the available media quality.</p>
              </div>
              <div className="step-card">
                <span>3</span>
                <h3>Download</h3>
                <p>Choose a format and save it instantly without an account.</p>
              </div>
            </div>
          </section>

          <section className="info-section" id="features">
            <div className="section-header">
              <span className="eyebrow">Built for speed</span>
              <h2>Why People Use Veltrix</h2>
            </div>
            <div className="feature-list">
              <div className="feature-item">
                <strong>Fast</strong>
                <p>Quick analysis and direct media choices for supported content.</p>
              </div>
              <div className="feature-item">
                <strong>Free</strong>
                <p>No login, no subscription, no payment gate for the downloader.</p>
              </div>
              <div className="feature-item">
                <strong>Private</strong>
                <p>Uses anonymous technical identifiers only where needed for abuse protection.</p>
              </div>
            </div>
          </section>

          <div className="responsive-ad-wrap">
            <AdSlot position="inline" size="responsive" />
          </div>

          <section className="faq" id="faq">
            <div className="section-header">
              <span className="eyebrow">Common questions</span>
              <h2>FAQ</h2>
            </div>
            <div className="faq-list">
              <div className="faq-item">
                <h3>Do I need an account?</h3>
                <p>No. The downloader works without logging in or creating a profile.</p>
              </div>
              <div className="faq-item">
                <h3>Is it free?</h3>
                <p>Yes. The tool is designed to be completely free to use.</p>
              </div>
              <div className="faq-item">
                <h3>Are ads included?</h3>
                <p>Yes, ad spaces are reserved to support the free service without interfering with the main flow.</p>
              </div>
            </div>
          </section>

          <footer className="site-footer">
            <div className="footer-brand">Veltrix Softwares</div>
            <p>Free media download utility for supported URLs.</p>
          </footer>
        </main>

        <aside className="ad-rail ad-rail--right" aria-label="Right advertisement column">
          <AdSlot position="right" size="desktop" />
        </aside>
      </div>
    </div>
  );
}

export default App;
