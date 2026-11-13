import { prerender } from 'react-dom/static';
import { Root } from './App.tsx';
import { browserDeps, Cockpit } from './cockpit.ts';

/** The cockpit's first paint as static HTML: the sheet before its first read. Nothing here touches the browser. */
export async function render(): Promise<string> {
  const { prelude } = await prerender(<Root cockpit={new Cockpit(browserDeps())} />);
  return new Response(prelude).text();
}
