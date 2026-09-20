import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './context/AppContext.jsx';
import { Icons, Banner, Loading } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Queue from './pages/Queue.jsx';
import Inbox from './pages/Inbox.jsx';
import Prospects from './pages/Prospects.jsx';
import ProspectDetail from './pages/ProspectDetail.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Agents from './pages/Agents.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Controls from './pages/Controls.jsx';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: Icons.activity },
  { to: '/campaigns', label: 'Campaigns', icon: Icons.target },
  { to: '/prospects', label: 'Prospects', icon: Icons.people },
  { to: '/queue', label: 'Approvals', icon: Icons.queue, badge: 'approvals' },
  { to: '/inbox', label: 'Inbox', icon: Icons.send },
  { to: '/knowledge', label: 'Knowledge', icon: Icons.book },
];

// Configuration, not day-to-day work — kept out of the main list and grouped
// under its own label at the bottom of the sidebar, one step removed from
// the screens an operator opens every run.
const SETTINGS_NAV = [
  { to: '/agents', label: 'Agents', icon: Icons.bot },
  { to: '/controls', label: 'Controls', icon: Icons.shield },
];

function Sidebar() {
  const { openApprovals, connection, user, signOut, health } = useApp();

  const dot =
    connection === 'connected' ? 'var(--ok)' :
    connection === 'degraded' ? 'var(--warn)' : 'var(--stop)';

  const label =
    connection === 'connected' ? 'API connected' :
    connection === 'degraded' ? 'API degraded' :
    connection === 'not_configured' ? 'API address not set' : 'API unreachable';

  const routing = health?.config?.agent_routing ?? {};
  const live = Object.values(routing).filter((e) => e === 'llm_engine').length;
  const total = Object.values(routing).filter((e) => e !== 'our_engine').length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src="/logo-icon.png" alt="Pigeon" />
        </div>
        <div>
          <div className="brand-name">Pigeon</div>
          <div className="brand-sub">Autonomous SDR</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.map(({ to, label: text, icon: I, badge }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
            <I className="nav-icon" />
            {text}
            {badge === 'approvals' && openApprovals > 0 && (
              <span className="nav-count alert">{openApprovals}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <nav className="nav nav-settings">
        <div className="nav-label">Settings</div>
        {SETTINGS_NAV.map(({ to, label: text, icon: I }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
            <I className="nav-icon" />
            {text}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="row" style={{ gap: 6 }}>
          <i className="dot" style={{ background: dot }} />
          <span>{label}</span>
        </div>
        {total > 0 && (
          <div style={{ marginTop: 4 }}>
            {live} of {total} agents live on Groq/Gemini
          </div>
        )}
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {user?.email ?? user?.name}
          </span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={signOut} title="Sign out">
            <Icons.logout size={13} />
          </button>
        </div>
      </div>
    </aside>
  );
}

const JOB_TYPE_LABEL = {
  campaign_run: 'Running',
  discovery: 'Finding people for',
  prospect_advance: 'Advancing a prospect in',
};

const JOB_DESTINATION = { campaign_run: '/campaigns', discovery: '/campaigns', prospect_advance: '/prospects' };

/**
 * Visible on every screen, not just the one that started the job. A run takes
 * minutes and keeps going on the server no matter where you navigate to; the
 * one thing worth surfacing everywhere is that it is still in flight and
 * where to go watch it, so leaving the page never means losing track of it.
 */
function ActiveJobsBar() {
  const { activeJobs } = useApp();
  if (!activeJobs?.length) return null;

  const [first, ...rest] = activeJobs;
  const pct = first.percent;

  return (
    <Link to={JOB_DESTINATION[first.type] ?? '/campaigns'} className="job-bar-global">
      <span className="spin" />
      <span className="job-bar-text">
        {JOB_TYPE_LABEL[first.type] ?? first.type} {first.campaign_name ?? 'a campaign'}
        {first.total > 0 ? ` — ${first.processed}/${first.total}` : ''}
        {rest.length > 0 ? ` · +${rest.length} more running` : ''}
      </span>
      <span className="job-bar-track">
        <i style={{ width: pct === null ? '30%' : `${pct}%` }} />
      </span>
      <span className="job-bar-go">View <Icons.chevron size={11} /></span>
    </Link>
  );
}

function ConnectionBanner() {
  const { connection, error, probe, health } = useApp();
  if (connection === 'connected') return null;

  if (connection === 'not_configured') {
    return (
      <Banner tone="warn">
        <b>The API address is not set.</b> Add <code className="mono">VITE_API_BASE_URL</code> in
        the Vercel project settings, pointing at your Railway URL with no trailing slash, then
        redeploy. Vite reads that value at build time, so a redeploy is required.
      </Banner>
    );
  }

  if (connection === 'degraded') {
    const missing = health?.config?.missing_required ?? [];
    return (
      <Banner tone="warn">
        <b>The API is running but its database is not ready.</b>{' '}
        {missing.length
          ? `Missing on the API: ${missing.join(', ')}.`
          : health?.message ?? 'Check the Supabase credentials on the API.'}
      </Banner>
    );
  }

  return (
    <Banner tone="stop">
      <b>Cannot reach the API.</b> {error}{' '}
      <button className="btn sm" style={{ marginTop: 8 }} onClick={probe}>
        <Icons.refresh size={13} /> Try again
      </button>
    </Banner>
  );
}

export default function App() {
  const { user, authReady } = useApp();
  const location = useLocation();

  if (!authReady) {
    return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><Loading label="Starting" /></div>;
  }

  if (!user) return <Login />;

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <ActiveJobsBar />
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace state={{ from: location }} />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/prospects" element={<Prospects />} />
          <Route path="/prospects/:id" element={<ProspectDetail />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/controls" element={<Controls />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export { ConnectionBanner };
