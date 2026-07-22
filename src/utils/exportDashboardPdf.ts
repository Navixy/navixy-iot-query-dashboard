/**
 * Client-side dashboard → PDF export (FEAT-826).
 *
 * A dashboard is a heterogeneous grid of Recharts / Leaflet / table panels that
 * only render faithfully in a real browser, so we rasterize the rendered grid with
 * modern-screenshot and assemble a paginated PDF with jsPDF — entirely client-side.
 * Nothing is uploaded: the PDF is built and downloaded locally, which keeps request
 * bodies small (no data/rows/images ever cross the wire) and makes the export
 * WYSIWYG — it reflects the current filters, timepicker and table page on screen.
 *
 * modern-screenshot draws the DOM through an SVG <foreignObject>, i.e. the browser's
 * own layout/paint engine, so the raster matches the screen exactly (flex centering,
 * the donut "Total" label, title-icon alignment, fonts) — unlike html2canvas, whose
 * reimplemented CSS engine skewed those. We capture an off-screen clone so we can
 * reveal content the panels clip on screen without disturbing the live dashboard:
 * each panel's hidden vertical overflow is measured and the panel grown (reflowing
 * the rows below it) so full tables render — capped per panel, with an "export
 * Excel/CSV" note when a table is too large to fit.
 *
 * modern-screenshot and jsPDF are dynamically imported so they only ship to users
 * who actually export (they stay out of the main bundle).
 */

import { downloadBlob } from './downloadBlob';

export interface DashboardPdfOptions {
  /** Report page title, printed in the PDF header. */
  title: string;
  /** Optional subtitle, printed under the title. */
  subtitle?: string;
  /** Output file name (without extension). Falls back to a slug of the title. */
  fileName?: string;
  /** Generation timestamp; defaults to now. */
  generatedAt?: Date;
  /**
   * Localized note stamped onto a clipped (too-tall) table panel. Defaults to
   * English so the util stays usable standalone; the app passes a translated
   * string. Rendered into the exported PDF, so it is user-facing.
   */
  partialDataNote?: string;
}

const DEFAULT_PARTIAL_DATA_NOTE = 'Partial data shown — export Excel or CSV for all rows.';

// A4 landscape in PDF points (1pt = 1/72"). Dashboards use a wide 24-column grid,
// so landscape wastes less space than portrait.
const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = 28; // pt, around the page
const HEADER_HEIGHT = 46; // pt, reserved above the image on page 1 only
const FOOTER_HEIGHT = 20; // pt, reserved below the image on every page

// Cap the capture so an extremely tall/large dashboard can't blow past the browser's
// canvas limits (either yields a blank capture). The scale is shrunk — below 1x if
// needed — to keep both the per-side dimension and the total area within bounds.
const MAX_CANVAS_DIM = 14000; // px per side (browsers cap around 16k)
const MAX_CANVAS_AREA = 16_000_000; // px² total (Safari caps around 16.7M)
const CAPTURE_SCALE = 2;

// How much a single panel may grow to reveal a scrolled table (CSS px). Beyond
// this the table is clipped and gets an "export Excel/CSV" note, so one huge table
// can't inflate (and force a downscale of) the whole PDF. ~50 rows.
const MAX_PANEL_EXPAND = 2200;
const DISCLAIMER_HEIGHT = 26; // px strip appended to a clipped table panel
// Ignore sub-pixel / cosmetic overflow so tiles and charts aren't nudged for nothing.
const MIN_PANEL_OVERFLOW = 4;

// A 1x1 transparent GIF. modern-screenshot inlines every <img>/background-image by
// fetching it and, when that fetch fails (e.g. a text-panel image from a host with no
// CORS headers), swaps in this placeholder rather than keeping the original cross-origin
// src — so a foreign image renders blank instead of tainting the canvas and breaking
// toDataURL. We pass it explicitly so the behaviour doesn't hinge on the library default.
const TRANSPARENT_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Turn an arbitrary title into a safe, compact file-name slug. */
function slugify(input: string, fallback = 'dashboard'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

/** Parse a CSS color (`rgb()`, `rgba()` or `#hex`) into 0–255 components. */
function parseColor(color: string): { r: number; g: number; b: number } {
  const rgbMatch = color.match(/rgba?\(([^)]+)\)/i);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1].split(',').map((v) => parseFloat(v.trim()));
    return { r: r || 0, g: g || 0, b: b || 0 };
  }
  const hex = color.replace('#', '').trim();
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length >= 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

/**
 * Walk up from the element to the first element with a non-transparent
 * background, falling back to the document body. Used both as the capture
 * backdrop and to theme the PDF chrome (light vs dark) to match the app.
 */
function resolveBackground(element: HTMLElement): { r: number; g: number; b: number } {
  let node: HTMLElement | null = element;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    // `rgba(0, 0, 0, 0)` is the computed value of a transparent background; match it
    // exactly so a deliberately translucent-black panel (e.g. rgba(0,0,0,0.6)) isn't
    // mistaken for transparent and skipped.
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      return parseColor(bg);
    }
    node = node.parentElement;
  }
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  return parseColor(bodyBg || 'rgb(255,255,255)');
}

/** Relative luminance — used to pick readable header/footer text over the page fill. */
function isDark({ r, g, b }: { r: number; g: number; b: number }): boolean {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

/** Yield to the browser so a "generating…" spinner can paint before the heavy capture. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

interface PanelPlan {
  newTop: number;
  newHeight: number;
  /** This panel had hidden overflow we expand to reveal. */
  grow: boolean;
  /** Overflow exceeded the cap — clip and show the disclaimer instead. */
  clip: boolean;
}

interface ExpansionPlan {
  panels: PanelPlan[];
  captureHeight: number;
}

/** Absolutely-positioned grid children (panels + row headers), in DOM order. */
function gridItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.style.position === 'absolute',
  );
}

/**
 * The absolutely-positioned grid container inside the export root. Prefers the stable
 * `data-panel-grid` hook, then PanelGrid's class, then any element whose direct children
 * are the absolute panels — so a class rename doesn't silently produce a blank export.
 */
function findGridContainer(root: HTMLElement): HTMLElement | null {
  const marked = root.querySelector<HTMLElement>('[data-panel-grid]');
  if (marked) return marked;
  const byClass = root.querySelector<HTMLElement>('.relative.w-full');
  if (byClass && gridItems(byClass).length) return byClass;
  for (const el of root.querySelectorAll<HTMLElement>('div')) {
    if (gridItems(el).length) return el;
  }
  return byClass ?? null;
}

/**
 * Highest safe page cut at or above `target` (canvas px): moves the cut up out of any
 * panel it would slice through so a panel/table row isn't split across pages. Falls back
 * to `target` (a hard cut) when a single panel is taller than one page.
 */
function snapPageCut(
  target: number,
  srcY: number,
  bounds: { top: number; bottom: number }[],
): number {
  let cut = target;
  for (let guard = 0; guard <= bounds.length; guard++) {
    let highestCrossedTop = Infinity;
    for (const b of bounds) {
      if (b.top < cut - 0.5 && cut + 0.5 < b.bottom && b.top < highestCrossedTop) {
        highestCrossedTop = b.top;
      }
    }
    if (highestCrossedTop === Infinity) return cut; // lands in a gap
    if (highestCrossedTop <= srcY) return target; // panel taller than a page — hard cut
    cut = highestCrossedTop;
  }
  return target;
}

/**
 * Measure how much each panel must grow to reveal its scrolled content, then reflow
 * every grid row downward so nothing overlaps. Runs on the off-screen clone; the plan
 * is applied to that same clone, so the live dashboard is never mutated.
 */
function measureExpansion(root: HTMLElement): ExpansionPlan {
  const container = findGridContainer(root);
  if (!container) return { panels: [], captureHeight: root.scrollHeight };

  const items = gridItems(container);
  const measured = items.map((el) => {
    const top = parseFloat(el.style.top) || 0;
    const height = parseFloat(el.style.height) || el.getBoundingClientRect().height;
    // Largest vertical overflow among descendants that actually scroll — the real
    // table/content scroller. Test the (cheap) overflow mode first so only the handful
    // of auto/scroll nodes pay for the scrollHeight/clientHeight layout read, turning
    // O(total DOM) layout reads into O(scrollers) — typically one per panel.
    let overflow = 0;
    el.querySelectorAll('*').forEach((d) => {
      if (!(d instanceof HTMLElement)) return;
      const oy = getComputedStyle(d).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return;
      const o = d.scrollHeight - d.clientHeight;
      if (o > overflow) overflow = o;
    });
    return { top, height, overflow };
  });

  // Group panels into grid rows by their (shared) top coordinate.
  const rowsByTop = new Map<number, number[]>();
  measured.forEach((m, i) => {
    const key = Math.round(m.top);
    const bucket = rowsByTop.get(key);
    if (bucket) bucket.push(i);
    else rowsByTop.set(key, [i]);
  });

  const panels: PanelPlan[] = new Array(measured.length);
  let offset = 0; // accumulated downward shift from expanded rows above
  for (const top of [...rowsByTop.keys()].sort((a, b) => a - b)) {
    const idxs = rowsByTop.get(top)!;
    let rowGrow = 0;
    for (const i of idxs) {
      const m = measured[i];
      const meaningful = m.overflow > MIN_PANEL_OVERFLOW;
      const clip = m.overflow > MAX_PANEL_EXPAND;
      const grow = meaningful
        ? Math.min(m.overflow, MAX_PANEL_EXPAND) + (clip ? DISCLAIMER_HEIGHT : 0)
        : 0;
      panels[i] = {
        newTop: Math.round(top + offset),
        newHeight: Math.round(m.height + grow),
        grow: grow > 0,
        clip,
      };
      if (grow > rowGrow) rowGrow = grow;
    }
    offset += rowGrow;
  }

  const containerHeight = container.getBoundingClientRect().height;
  return { panels, captureHeight: Math.ceil(containerHeight + offset) };
}

/** Apply the reflow/expansion plan to the off-screen clone of the grid. */
function applyExpansion(root: HTMLElement, plan: ExpansionPlan, partialDataNote: string): void {
  root.style.height = `${plan.captureHeight}px`;
  const container = findGridContainer(root);
  if (!container) return;
  container.style.minHeight = `${plan.captureHeight}px`;
  container.style.height = `${plan.captureHeight}px`;

  gridItems(container).forEach((el, i) => {
    const p = plan.panels[i];
    if (!p) return;
    el.style.top = `${p.newTop}px`;
    el.style.height = `${p.newHeight}px`;
    if (!p.grow) return;

    // Grow the panel's inner boxes so content it clips on screen (mainly long tables)
    // renders in full. The browser clips overflow:auto/scroll/hidden to each element's
    // box, so revealing it means pinning each scroller's minHeight to its content
    // height, dropping maxHeight caps, and opening overflow:hidden wrappers — a
    // percentage-height box wouldn't grow from just flipping overflow to visible. When
    // a table is capped we instead clip its scroller so it stops at the disclaimer
    // strip. Horizontal overflow is left alone (wide tables clip at the panel edge).
    el.querySelectorAll('*').forEach((d) => {
      if (!(d instanceof HTMLElement)) return;
      const cs = getComputedStyle(d);
      const scrolls = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      if (p.clip) {
        if (scrolls) d.style.overflowY = 'hidden';
        return;
      }
      if (scrolls) {
        d.style.overflowY = 'visible';
        d.style.maxHeight = 'none';
        d.style.minHeight = `${d.scrollHeight}px`; // grow the box to contain all content
      } else {
        if (cs.overflowY === 'hidden') d.style.overflowY = 'visible';
        if (cs.maxHeight !== 'none') d.style.maxHeight = 'none';
      }
    });

    if (p.clip) {
      const note = document.createElement('div');
      note.textContent = partialDataNote;
      note.style.cssText =
        `position:absolute;left:0;right:0;bottom:0;height:${DISCLAIMER_HEIGHT}px;` +
        'display:flex;align-items:center;justify-content:center;' +
        'font-size:11px;font-family:helvetica,arial,sans-serif;color:#64748b;' +
        'background:rgba(148,163,184,0.12);border-top:1px solid rgba(148,163,184,0.30);';
      el.appendChild(note); // el is position:absolute, so the note anchors to it
    }
  });
}

/**
 * Capture a rendered dashboard grid element and download it as a multi-page PDF.
 *
 * @param element The DOM node wrapping the panel grid (the full-height container).
 * @param options Title/subtitle/filename metadata for the PDF header.
 */
export async function exportDashboardToPdf(
  element: HTMLElement,
  options: DashboardPdfOptions,
): Promise<void> {
  const [{ domToCanvas }, { jsPDF }] = await Promise.all([
    import('modern-screenshot'),
    import('jspdf'),
  ]);

  const generatedAt = options.generatedAt ?? new Date();
  const bg = resolveBackground(element);
  const bgCss = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
  const width = Math.ceil(element.getBoundingClientRect().width);

  // Let the loading state paint before the heavy work.
  await nextFrame();

  // Render from an off-screen clone. modern-screenshot draws the DOM through an SVG
  // <foreignObject> — the browser's own paint engine — so the PDF matches the
  // on-screen layout exactly (flex centering, the donut's "Total" label, title-icon
  // alignment, fonts), which html2canvas's reimplemented CSS engine could not.
  // Cloning lets us reveal content the panels clip on screen (full tables) without
  // disturbing the live dashboard.
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.position = 'fixed';
  clone.style.left = '-100000px';
  clone.style.top = '0';
  clone.style.width = `${width}px`;
  clone.style.maxWidth = 'none';
  clone.style.margin = '0';
  clone.style.background = bgCss;
  document.body.appendChild(clone);

  let canvas: HTMLCanvasElement | null = null;
  let plan: ExpansionPlan = { panels: [], captureHeight: 0 };
  try {
    plan = measureExpansion(clone);
    if (!plan.panels.length) {
      throw new Error("Couldn't find the dashboard grid to export.");
    }
    applyExpansion(clone, plan, options.partialDataNote ?? DEFAULT_PARTIAL_DATA_NOTE);
    void clone.offsetHeight; // force a layout pass before capturing

    // Shrink the scale — below 1x if needed — so the output canvas stays within both the
    // per-side dimension and the total-area limits; otherwise domToCanvas returns blank.
    const scale = Math.min(
      CAPTURE_SCALE,
      MAX_CANVAS_DIM / plan.captureHeight,
      MAX_CANVAS_DIM / width,
      Math.sqrt(MAX_CANVAS_AREA / (width * plan.captureHeight)),
    );

    canvas = await domToCanvas(clone, {
      scale,
      backgroundColor: bgCss,
      // Degrade un-fetchable images to a transparent placeholder so one foreign image
      // in a text/markdown panel can't taint the canvas and abort the whole export.
      fetch: { placeholderImage: TRANSPARENT_PLACEHOLDER },
    });
  } finally {
    clone.remove();
  }

  if (!canvas || !canvas.width || !canvas.height) {
    throw new Error('Nothing to export — the dashboard did not render any content.');
  }

  // Panel bounds in canvas px, so page cuts can snap to the gaps between grid rows.
  const yScale = plan.captureHeight ? canvas.height / plan.captureHeight : 1;
  const panelBounds = plan.panels.map((p) => ({
    top: p.newTop * yScale,
    bottom: (p.newTop + p.newHeight) * yScale,
  }));

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  const contentW = PAGE.width - MARGIN * 2;
  const pxToPt = contentW / canvas.width; // image px → pt when fitted to content width
  const usableFirst = PAGE.height - MARGIN - HEADER_HEIGHT - MARGIN - FOOTER_HEIGHT;
  const usableRest = PAGE.height - MARGIN - MARGIN - FOOTER_HEIGHT;

  // Reusable slice canvas: we copy a horizontal band of the source per page so no
  // panel-heavy page is ever a single oversized image.
  const slice = document.createElement('canvas');
  const sliceCtx = slice.getContext('2d');
  if (!sliceCtx) throw new Error('Unable to prepare the export canvas.');
  // The slice width is the source width on every page; assigning canvas.width reallocates
  // the backing store, so set it once here and only vary height per page below.
  slice.width = canvas.width;

  let srcY = 0;
  let pageIndex = 0;
  while (srcY < canvas.height) {
    const isFirst = pageIndex === 0;
    const usablePt = isFirst ? usableFirst : usableRest;
    const topPt = isFirst ? MARGIN + HEADER_HEIGHT : MARGIN;
    const maxSliceHpx = Math.min(canvas.height - srcY, Math.floor(usablePt / pxToPt));
    // Snap the cut up to a gap between grid rows so a panel/table row isn't split across
    // pages — unless this is the final band, or snapping would waste over half the page
    // (a panel taller than that), in which case we accept a hard cut.
    const snapped = snapPageCut(srcY + maxSliceHpx, srcY, panelBounds);
    const useSnap =
      srcY + maxSliceHpx < canvas.height && snapped - srcY >= maxSliceHpx * 0.5;
    const sliceHpx = useSnap ? snapped - srcY : maxSliceHpx;
    if (sliceHpx <= 0) break;

    // Assigning height clears the bitmap and resets the 2d context, so re-apply the fill
    // each page. Width is fixed above, so its (larger) backing store isn't reallocated.
    slice.height = sliceHpx;
    sliceCtx.fillStyle = bgCss;
    sliceCtx.fillRect(0, 0, slice.width, slice.height);
    sliceCtx.drawImage(canvas, 0, srcY, canvas.width, sliceHpx, 0, 0, canvas.width, sliceHpx);
    // JPEG (high quality) keeps multi-page dashboards to a sane file size vs PNG.
    let img: string;
    try {
      img = slice.toDataURL('image/jpeg', 0.95);
    } catch {
      // A cross-origin image without CORS taints the canvas, making toDataURL throw a
      // SecurityError. modern-screenshot's placeholder swap prevents this for <img> and
      // CSS backgrounds; this guard covers any residual vector (e.g. an embedded video)
      // with a clear, actionable message instead of a generic "Export failed". Taint is
      // all-or-nothing, so no partial PDF is possible — fail fast with guidance.
      throw new Error(
        'The dashboard includes an image from another site that blocks embedding, so it ' +
          'can’t be exported. Host the image on this site or remove it, then try again.',
      );
    }

    if (!isFirst) pdf.addPage();
    // Fill the page so margins match the dashboard background in both themes.
    pdf.setFillColor(bg.r, bg.g, bg.b);
    pdf.rect(0, 0, PAGE.width, PAGE.height, 'F');
    if (isFirst) drawHeader(pdf, options, generatedAt, bg);
    pdf.addImage(img, 'JPEG', MARGIN, topPt, contentW, sliceHpx * pxToPt);

    srcY += sliceHpx;
    pageIndex++;
  }

  // Footer / page numbers, stamped once the total is known.
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    drawFooter(pdf, i, total, options.title, bg);
  }

  // Route through the shared download helper (one object-URL lifecycle for every export)
  // rather than jsPDF's built-in save().
  downloadBlob(pdf.output('blob'), `${slugify(options.fileName || options.title)}.pdf`);
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` pt in jsPDF's current font. */
function fitText(pdf: import('jspdf').jsPDF, text: string, maxWidth: number): string {
  if (!text || pdf.getTextWidth(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && pdf.getTextWidth(`${t}…`) > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

function drawHeader(
  pdf: import('jspdf').jsPDF,
  options: DashboardPdfOptions,
  generatedAt: Date,
  bg: { r: number; g: number; b: number },
): void {
  const dark = isDark(bg);
  const strong: [number, number, number] = dark ? [233, 241, 255] : [15, 23, 42];
  const muted: [number, number, number] = dark ? [148, 163, 184] : [100, 116, 139];

  // Measure the right-aligned timestamp first so the title can be truncated to the
  // space left of it — otherwise a long title runs straight into the stamp.
  const stamp = `Generated ${generatedAt.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  const stampWidth = pdf.getTextWidth(stamp);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.setTextColor(...strong);
  const titleMaxWidth = PAGE.width - MARGIN * 2 - stampWidth - 16;
  pdf.text(fitText(pdf, options.title || 'Dashboard', titleMaxWidth), MARGIN, MARGIN + 15);

  if (options.subtitle) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...muted);
    pdf.text(fitText(pdf, options.subtitle, PAGE.width - MARGIN * 2), MARGIN, MARGIN + 31);
  }

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...muted);
  pdf.text(stamp, PAGE.width - MARGIN, MARGIN + 15, { align: 'right' });

  // Divider under the header.
  pdf.setDrawColor(dark ? 34 : 226, dark ? 49 : 232, dark ? 75 : 240);
  pdf.setLineWidth(0.5);
  pdf.line(MARGIN, MARGIN + HEADER_HEIGHT - 8, PAGE.width - MARGIN, MARGIN + HEADER_HEIGHT - 8);
}

function drawFooter(
  pdf: import('jspdf').jsPDF,
  page: number,
  total: number,
  title: string,
  bg: { r: number; g: number; b: number },
): void {
  const muted: [number, number, number] = isDark(bg)
    ? [120, 137, 163]
    : [148, 163, 184];
  const y = PAGE.height - MARGIN + 4;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(...muted);
  if (title) {
    const label = title.length > 90 ? `${title.slice(0, 90)}…` : title;
    pdf.text(label, MARGIN, y);
  }
  pdf.text(`Page ${page} of ${total}`, PAGE.width - MARGIN, y, { align: 'right' });
}
