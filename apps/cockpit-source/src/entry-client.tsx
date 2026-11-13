import { hydrateRoot } from 'react-dom/client';
import { Root } from './App.tsx';
import { browserDeps, Cockpit } from './cockpit.ts';
import './cockpit.css';

// The build prerenders the cockpit's first paint into #root; hydrate it, then read the
// live Directions, Workers and PROGRESS from the Forge server.
const container = document.getElementById('root');
if (!container) throw new Error('index.html needs a #root element');
hydrateRoot(container, <Root cockpit={new Cockpit(browserDeps())} />);
