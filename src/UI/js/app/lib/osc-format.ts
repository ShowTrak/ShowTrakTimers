// OSC reference formatting (ShowTrak Server's formatRoutePath and sections),
// pure for the tests.
import { Safe } from '../utils';

/** An OSC path as HTML, with each ":param" shown as a highlighted [param]. */
export function FormatRoutePath(PathValue: string | undefined): string {
  let Html = '';
  for (const Segment of String(PathValue || '')
    .split('/')
    .filter((S) => S.length > 0)) {
    Html += '<span>/</span>';
    Html += Segment.startsWith(':')
      ? `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`
      : `<span>${Safe(Segment)}</span>`;
  }
  return Html || '<span>/</span>';
}

/** The reference section a route belongs to, by its second path segment. */
export function RouteSection(PathValue: string): 'Control' | 'Timer' | 'All Timers' {
  const Segment =
    String(PathValue || '')
      .split('/')
      .filter(Boolean)[1] || '';
  if (Segment === 'Timer') return 'Timer';
  if (Segment === 'All') return 'All Timers';
  return 'Control';
}

export const ROUTE_SECTION_ORDER = ['Control', 'Timer', 'All Timers'] as const;
