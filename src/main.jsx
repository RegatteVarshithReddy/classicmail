import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { initApi } from './lib/api.js';
import App from './App.jsx';
import Compose from './components/Compose.jsx';

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="compose-fatal">
          <p><b>ClassicMail hit an unexpected problem.</b></p>
          <p className="muted">{String(this.state.error && this.state.error.message)}</p>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

(async () => {
  await initApi();
  const compose = /^#\/?compose/.test(location.hash);
  if (compose) {
    // The compose window shows HTML that came from mail (quoted replies, old drafts). Even if the sanitizer missed
    // something, the window may only load pictures and fonts that are embedded in the page itself.
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = "img-src data:; font-src data:; media-src 'none'";
    document.head.prepend(meta);
  }
  createRoot(document.getElementById('root')).render(<Boundary>{compose ? <Compose /> : <App />}</Boundary>);
})();
