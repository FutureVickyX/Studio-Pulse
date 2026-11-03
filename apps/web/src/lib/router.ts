/**
 * Hash routes (`#/projects/…`), so the static build works on any host without server rewrites.
 * `parseRoute` / `formatRoute` are pure (unit-tested); `useRoute` follows `hashchange`.
 * A task opens as a panel over any page: `?task=<id>`.
 */

import { useCallback, useEffect, useState } from 'react';

export type Section = 'overview' | 'projects' | 'tasks' | 'notes' | 'time';

export type Route =
  | { readonly name: 'overview' }
  | { readonly name: 'projects' }
  | { readonly name: 'project'; readonly id: string }
  | { readonly name: 'tasks'; readonly view: 'mine' | 'all' }
  | { readonly name: 'notes'; readonly id: string | null }
  | { readonly name: 'time' };

export interface Location {
  readonly route: Route;
  /** A task shown as a panel over the page. */
  readonly taskId: string | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sectionOf(route: Route): Section {
  switch (route.name) {
    case 'overview':
      return 'overview';
    case 'projects':
    case 'project':
      return 'projects';
    case 'tasks':
      return 'tasks';
    case 'notes':
      return 'notes';
    case 'time':
      return 'time';
  }
}

export function parseLocation(hash: string): Location {
  const raw = hash.replace(/^#/, '');
  const [path = '', query = ''] = raw.split('?', 2);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const task = new URLSearchParams(query).get('task');
  const taskId = task && ID.test(task) ? task.toLowerCase() : null;
  return { route: parseParts(parts), taskId };
}

function parseParts(parts: string[]): Route {
  const [first, second] = parts;
  switch (first) {
    case undefined:
    case '':
      return { name: 'overview' };
    case 'projects':
      return second && ID.test(second) ? { name: 'project', id: second.toLowerCase() } : { name: 'projects' };
    case 'tasks':
      return { name: 'tasks', view: second === 'all' ? 'all' : 'mine' };
    case 'notes':
      return { name: 'notes', id: second && ID.test(second) ? second.toLowerCase() : null };
    case 'time':
      return { name: 'time' };
    default:
      return { name: 'overview' };
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '#/';
    case 'projects':
      return '#/projects';
    case 'project':
      return `#/projects/${encodeURIComponent(route.id)}`;
    case 'tasks':
      return route.view === 'all' ? '#/tasks/all' : '#/tasks';
    case 'notes':
      return route.id ? `#/notes/${encodeURIComponent(route.id)}` : '#/notes';
    case 'time':
      return '#/time';
  }
}

export function formatLocation(location: Location): string {
  const base = formatRoute(location.route);
  return location.taskId ? `${base}?task=${encodeURIComponent(location.taskId)}` : base;
}

export interface Navigation {
  readonly location: Location;
  navigate: (route: Route) => void;
  openTask: (taskId: string | null) => void;
}

export function useNavigation(): Navigation {
  const [location, setLocation] = useState<Location>(() => parseLocation(window.location.hash));

  useEffect(() => {
    const onChange = () => setLocation(parseLocation(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((next: Location) => {
    const hash = formatLocation(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    else setLocation(next);
  }, []);

  const navigate = useCallback((route: Route) => go({ route, taskId: null }), [go]);
  const openTask = useCallback(
    (taskId: string | null) => go({ route: parseLocation(window.location.hash).route, taskId }),
    [go],
  );
  return { location, navigate, openTask };
}
