// @vitest-environment jsdom
//
// The rail's gestures are the feature, so these tests drive the pointer rather than
// clicking: pointing at a ring is what opens its card, and leaving the surface is
// what closes it. React maps `pointerover`/`pointerout` onto `onPointerEnter`/
// `onPointerLeave`, which is why the events below are `pointerOver`/`pointerOut`.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NOW, renderPanel } from '../helpers/windows';
import { PanelApp } from '../../src/desktop/panel/PanelApp';
import { defaultPanelSettings, failedStateOf, metricOf, providerStateOf, snapshotOf, createFakeUsageClient } from '../../src/desktop/lib/fake-client';
import { MINIMAL_RAIL_DETAIL_WIDTH, MINIMAL_RAIL_WIDTH, RAIL_GEOMETRY } from '../../src/desktop/panel/minimal-layout';

function client(balance = 86.42) {
  return createFakeUsageClient({
    settings: defaultPanelSettings({ panelDisplayMode: 'minimal', platformOrder: ['deepseek', 'codex', 'glm'] }),
    snapshot: snapshotOf([
      providerStateOf('codex', [
        metricOf({ key: 'quota.5h.used', unit: 'percent', direction: 'used', value: 24, windowSeconds: 18000 }),
        metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 76, windowSeconds: 18000 })
      ]),
      providerStateOf('glm', [
        metricOf({ key: 'quota.5h.used', unit: 'percent', direction: 'used', value: 28, connection: { provider: 'glm', connection: 'quota' } }),
        metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 72, connection: { provider: 'glm', connection: 'quota' } })
      ]),
      providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', unit: 'CNY', direction: 'balance', value: balance })])
    ])
  });
}

const ring = (name: RegExp) => screen.findByRole('button', { name });
/**
 * Stand in for hit testing, which jsdom does not implement.
 *
 * The host's probe hands the rail a point and the rail asks the document what is under
 * it; a test supplies the answer and records the point that was asked about.
 */
function stubElementFromPoint(target: Element | null) {
  const calls: Array<[number, number]> = [];
  const under = { current: target };
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => { calls.push([x, y]); return under.current; }
  });
  return { calls, under, restore: () => { Reflect.deleteProperty(document, 'elementFromPoint'); } };
}
const rail = () => screen.findByTestId('minimal-rail');
/**
 * The detail's frame, present for as long as the rail is.
 *
 * The frame is deliberately *not* unmounted when the card closes: this window is
 * transparent, and inserting and removing its largest box is what makes WebKit
 * re-composite the whole surface (the blink). So "is the card there" is its state —
 * hidden and inert, or shown — and the test asks that question, not the DOM's.
 */
const frame = () => screen.queryByTestId('minimal-detail');
const card = () => (frame()?.getAttribute('aria-hidden') === 'false' ? frame() : null);
/** The ring's arc, read as the first number of its dash, which is the percentage. */
const arcPercent = (element: HTMLElement) => {
  const arc = element.querySelector('.minimal-ring-arc');
  expect(arc, 'the ring has no arc').not.toBeNull();
  const dash = (arc as SVGElement).style.strokeDasharray;
  return Number.parseFloat(dash) / 1.068;
};
/** The vertical centre of the rail's Nth slot, which is what a card's caret points at. */
const centreOf = (index: number) =>
  RAIL_GEOMETRY.railBorder +
  RAIL_GEOMETRY.railPaddingTop +
  RAIL_GEOMETRY.itemHeight / 2 +
  index * (RAIL_GEOMETRY.itemHeight + RAIL_GEOMETRY.itemGap);

describe('minimal panel', () => {
  it('keeps the native rail at 58 points while an independent detail is selected', async () => {
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenCalledWith('codex', 1));
    expect(view.host.onSetMinimalLayout).toHaveBeenLastCalledWith(MINIMAL_RAIL_WIDTH, expect.any(Number), false);
    expect(screen.queryByTestId('minimal-detail')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenLastCalledWith(null, 0));
    expect(view.host.onSetMinimalLayout).toHaveBeenLastCalledWith(MINIMAL_RAIL_WIDTH, expect.any(Number), false);
  });

  it('clears a host dismissal and reopens on pointer movement without a click', async () => {
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const codex = await ring(/Codex.*详情/);
    fireEvent.pointerOver(codex);
    await waitFor(() => expect(codex).toHaveClass('is-active'));
    window.dispatchEvent(new CustomEvent('panel:minimal-detail-dismiss', { detail: { focus: false } }));
    await waitFor(() => expect(codex).not.toHaveClass('is-active'));
    fireEvent.pointerMove(codex, { pointerType: 'mouse' });
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenLastCalledWith('codex', 1));
  });

  it('re-asks the host for a ring the rail already believes is open', async () => {
    // The host closes the card itself when the pointer leaves both windows, and the
    // message that says so can be missed. A rail that short-circuits on its own copy of
    // the selection then does nothing at all when the reader points at that ring again —
    // the hover that "stopped working". Re-asking is a no-op host-side when the selection
    // really is unchanged.
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const codex = await ring(/Codex.*详情/);
    fireEvent.pointerOver(codex);
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenCalledWith('codex', 1));
    onSetMinimalDetail.mockClear();
    fireEvent.pointerOver(codex);
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenCalledWith('codex', 1));
  });

  it('answers the host’s pointer probe when the webview sees no pointer events', async () => {
    // A webview only gets pointer events while its window is key, and the rail's often is
    // not (another app is in front, the settings window holds key). The host samples the
    // pointer for its header anyway and forwards the position; the rail answers with the
    // ring under that point. Without this, hovering did nothing at all in those states.
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const glm = await ring(/GLM.*详情/);
    const point = stubElementFromPoint(glm);
    try {
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 140 } }));
      await waitFor(() => expect(onSetMinimalDetail).toHaveBeenCalledWith('glm', 2));
      // The document answers one probe with two questions — which ring is this (here) and
      // which control is this (the painter in `PanelApp`) — so the hit is asked twice, at
      // the same point.
      expect(point.calls[0]).toEqual([20, 140]);
      expect(point.calls.every(([x, y]) => x === 20 && y === 140)).toBe(true);
    } finally {
      point.restore();
    }
  });

  it('paints the hover the webview cannot see on the rail’s own controls', async () => {
    // A webview only receives pointer events while its window is key, so on a pinned rail
    // the reader is working beside — the state this probe exists for — `:hover` never
    // fires: the actions, the connection badge and the empty-state links stayed flat
    // under the pointer until the panel had been clicked. The host already forwards the
    // pointer, so the rail paints that state itself.
    const cached = providerStateOf('codex', [
      metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 8, windowSeconds: 18000, confidence: ['authoritative', 'stale'] })
    ]);
    renderPanel({
      client: createFakeUsageClient({
        settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
        snapshot: snapshotOf([failedStateOf('codex', { kind: 'network', message: '连接失败', at: '2026-09-10T08:05:00.000Z' }, { snapshot: cached.snapshot })])
      })
    });
    const strip = await rail();
    const settingsButton = within(strip).getByRole('button', { name: '设置' });
    const alert = within(strip).getByRole('button', { name: /连接异常/ });
    const refresh = within(strip).getByRole('button', { name: /刷新/ });
    const point = stubElementFromPoint(settingsButton);
    try {
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 200 } }));
      await waitFor(() => expect(settingsButton).toHaveClass('is-hover'));
      // The paint travels with the pointer rather than accumulating on every control it
      // has crossed.
      point.under.current = alert;
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 190 } }));
      await waitFor(() => expect(alert).toHaveClass('is-hover'));
      expect(settingsButton).not.toHaveClass('is-hover');
      // A probe with no point is the host saying the pointer is off the panel.
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: null }));
      await waitFor(() => expect(alert).not.toHaveClass('is-hover'));
      // …and the next control the pointer reaches is painted in turn.
      point.under.current = refresh;
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 180 } }));
      await waitFor(() => expect(refresh).toHaveClass('is-hover'));
    } finally {
      point.restore();
    }
  });

  it('leaves a card the reader closed under the pointer closed', async () => {
    // `Escape` closes the card with the pointer still on its ring, and the probe fires
    // with no movement of the reader's own: honouring it would reopen the card a second
    // after the reader closed it. A real pointer move is the reader asking again.
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const codex = await ring(/Codex.*详情/);
    fireEvent.pointerOver(codex);
    await waitFor(() => expect(codex).toHaveClass('is-active'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(codex).not.toHaveClass('is-active'));
    onSetMinimalDetail.mockClear();
    const point = stubElementFromPoint(codex);
    try {
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 60 } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onSetMinimalDetail).not.toHaveBeenCalled();
      // The reader moving the mouse is asking again — the behaviour the rail had before
      // the probe existed.
      fireEvent.pointerMove(codex, { pointerType: 'mouse' });
      await waitFor(() => expect(onSetMinimalDetail).toHaveBeenLastCalledWith('codex', 1));
    } finally {
      point.restore();
    }
  });

  it('takes the platform card away once the pointer is on the rail but not on a platform', async () => {
    // The card is about a platform. Once the pointer is on the rail's own furniture — the
    // actions, the connection badge, the bands they sit in — there is nothing for it to be
    // about, and it is a window of its own, so nothing else would close it: the host's rule
    // only covers the pointer leaving the panel.
    const { container } = renderPanel({ client: client() });
    const strip = await rail();
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByRole('dialog', { name: 'Codex 详情' });
    fireEvent.pointerMove(within(strip).getByRole('button', { name: '设置' }));
    await waitFor(() => expect(card()).not.toBeInTheDocument());
    expect(container.querySelector('.minimal-detail')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeNull();
  });

  it('keeps the card a keyboard reader asked for, wherever the pointer is', async () => {
    // The rule is "the focus is not on the platform", and the keyboard's focus is a focus
    // too: a reader who activated a ring with Enter has their pointer wherever it happened
    // to be resting, and the card must not be taken away by a pointer they are not using.
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const codex = await ring(/Codex.*详情/);
    codex.focus();
    fireEvent.click(codex);
    await waitFor(() => expect(onSetMinimalDetail).toHaveBeenCalledWith('codex', 1));
    onSetMinimalDetail.mockClear();
    const point = stubElementFromPoint(within(await rail()).getByRole('button', { name: '设置' }));
    try {
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 200 } }));
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(onSetMinimalDetail).not.toHaveBeenCalled();
      // And the moment the keyboard's focus leaves the ring, the pointer's answer stands.
      codex.blur();
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 200 } }));
      await waitFor(() => expect(onSetMinimalDetail).toHaveBeenLastCalledWith(null, 0));
    } finally {
      point.restore();
    }
  });

  it('keeps the card while the pointer crosses to the next ring', async () => {
    // The rings are four points apart, so a pointer travelling from one platform to the
    // next is briefly over "no platform" — and the host samples it every 150 ms. Closing
    // on the first such sample would blink the card on the way past; the delay is what
    // tells passing over from stopping there.
    const { container } = renderPanel({ client: client() });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByRole('dialog', { name: 'Codex 详情' });
    fireEvent.pointerMove(container.querySelector('.minimal-panel')!);
    fireEvent.pointerMove(await ring(/GLM.*详情/));
    expect(await screen.findByRole('dialog', { name: 'GLM 详情' })).toBeInTheDocument();
    // The crossing's own timer is cancelled, not merely outrun.
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(card()).not.toBeNull();
  });

  it('keeps the card while the pointer is on it, and the connection view on the rail', async () => {
    // Two halves of one rule: the card is part of the platform's own surface, and the
    // connection view is a *click* the reader made rather than a hover.
    const cached = providerStateOf('codex', [
      metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 8, windowSeconds: 18000 })
    ]);
    renderPanel({
      client: createFakeUsageClient({
        settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
        snapshot: snapshotOf([failedStateOf('codex', { kind: 'network', message: '连接失败', at: '2026-09-10T08:05:00.000Z' }, { snapshot: cached.snapshot })])
      })
    });
    const strip = await rail();
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    const frame = await screen.findByTestId('minimal-detail');
    fireEvent.pointerMove(frame);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(card()).not.toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: /连接异常/ }));
    await screen.findByTestId('minimal-connection-body');
    fireEvent.pointerMove(within(strip).getByRole('button', { name: '设置' }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(within(frame).getByTestId('minimal-connection-body').closest('.minimal-detail-scroll')).toHaveAttribute('aria-hidden', 'false');
  });

  it('stops showing the platform card when the host reports the pointer off the rings', async () => {
    // The same rule for the input the webview cannot see: the host's probe says where the
    // pointer is, and a point on the rail's furniture is not a platform.
    const view = renderPanel({ client: client() });
    const onSetMinimalDetail = vi.fn();
    view.rerender(<PanelApp client={view.client} host={{ ...view.host, onSetMinimalDetail }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    const strip = await rail();
    const settings = within(strip).getByRole('button', { name: '设置' });
    const point = stubElementFromPoint(settings);
    try {
      window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 20, y: 200 } }));
      await waitFor(() => expect(onSetMinimalDetail).toHaveBeenLastCalledWith(null, 0));
    } finally {
      point.restore();
    }
  });

  it('keeps detail cards mounted while the rail opens and closes them', async () => {
    const { container } = renderPanel({ client: client() });
    const codex = await ring(/Codex.*详情/);
    const detail = frame()!;
    const mounted = detail.querySelector<HTMLElement>('[data-testid="card-codex"]');
    expect(mounted).not.toBeNull();
    expect(detail).toHaveAttribute('aria-hidden', 'true');

    fireEvent.pointerOver(codex);
    expect(await screen.findByRole('dialog', { name: 'Codex 详情' })).toContainElement(mounted);
    fireEvent.pointerOut(container.querySelector('.minimal-panel')!, { relatedTarget: document.body });
    await waitFor(() => expect(detail).toHaveAttribute('aria-hidden', 'true'));
    expect(detail.querySelector('[data-testid="card-codex"]')).toBe(mounted);

    fireEvent.pointerOver(codex);
    expect(await screen.findByRole('dialog', { name: 'Codex 详情' })).toContainElement(mounted);
  });

  it('follows the same host header visibility as the full panel', async () => {
    const view = renderPanel({ client: client() });
    const strip = await rail();
    const tools = strip.querySelector('.minimal-tools') as HTMLElement;
    expect(tools).toHaveAttribute('aria-hidden', 'false');
    expect(view.host.onSetMinimalLayout).toHaveBeenCalledWith(58, expect.any(Number), true);
    const blurredHost = { ...view.host, headerVisible: false };
    view.rerender(<PanelApp client={view.client} host={blurredHost} now={NOW} onOpenSettings={view.onOpenSettings} />);
    expect(tools).toHaveAttribute('aria-hidden', 'true');
    expect(within(tools).getByRole('button', { name: '设置', hidden: true })).toBeDisabled();
    expect(view.host.onSetMinimalLayout).toHaveBeenLastCalledWith(58, expect.any(Number), false);
    view.rerender(<PanelApp client={view.client} host={{ ...blurredHost, headerVisible: true }} now={NOW} onOpenSettings={view.onOpenSettings} />);
    expect(tools).toHaveAttribute('aria-hidden', 'false');
  });
  it('keeps settings reachable when all platforms are hidden', async () => {
    const { onOpenSettings } = renderPanel({ settings: { panelDisplayMode: 'minimal', platformVisibility: { codex: false, glm: false, deepseek: false } } });
    const strip = await rail();
    expect(within(strip).queryByRole('button', { name: /详情/ })).not.toBeInTheDocument();
    fireEvent.click(within(strip).getByRole('button', { name: '管理平台' }));
    expect(onOpenSettings).toHaveBeenCalledWith('platforms');
    fireEvent.click(within(strip.querySelector('.minimal-empty') as HTMLElement).getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledWith('appearance');
  });

  it('keeps the card overview on the companion web page whatever the stored mode says', async () => {
    // The web page is this same document served over loopback, so the stored mode
    // follows the reader into the browser. There is no host window to narrow and no
    // space to the left to expand into, so the page has to stay on the cards —
    // reading the same snapshot, visibility and order the desktop app is using.
    renderPanel({ client: client(), canReshapeWindow: false });
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByTestId('minimal-rail')).not.toBeInTheDocument();
    const cards = screen.getAllByTestId(/^card-/);
    expect(cards.map((element) => element.getAttribute('data-testid'))).toEqual([
      'card-deepseek',
      'card-codex',
      'card-glm'
    ]);
  });

  it('shows branded rings and their readings, with no caption under them', async () => {
    renderPanel({ client: client() });
    const strip = await rail();
    const items = within(strip).getAllByRole('button', { name: /详情/ });
    expect(items.map((item) => item.getAttribute('data-provider'))).toEqual(['deepseek', 'codex', 'glm']);
    expect(within(items[1]!).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    expect(within(items[0]!).getByRole('img', { name: 'DeepSeek' })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('76%');
    expect(items[0]).toHaveTextContent('¥86.42');
    // The window name and the balance caption would have to share a 58-point column
    // with the reading, so the rail draws only the reading. Both still reach a screen
    // reader through the accessible name, and the detail card spells them out.
    for (const caption of ['5h', '7d', '30d', '余额']) {
      expect(strip).not.toHaveTextContent(caption);
    }
    expect(items[1]).toHaveAccessibleName(/5h/);
    expect(items[0]).toHaveAccessibleName(/余额/);
  });

  it('drops the cents once a balance outgrows the column', async () => {
    // The column is 58 points wide: `¥1234.56` is nine figures and runs past it, where
    // `¥1235` is five. Above a hundred the rail keeps the whole part only, and the
    // accessible name carries the same reading the eye gets. The detail card is 330
    // points wide and still spells the balance out in full.
    renderPanel({ client: client(1_234.56) });
    const strip = await rail();
    const deepseek = within(strip).getByRole('button', { name: /DeepSeek.*详情/ });
    expect(deepseek).toHaveTextContent('¥1235');
    expect(deepseek).toHaveAccessibleName(/¥1235/);
    expect(strip).not.toHaveTextContent('1234.56');
  });

  it('leaves a balance ring empty instead of drawing a proportion', async () => {
    renderPanel({ client: client() });
    const strip = await rail();
    const [deepseek, codex] = within(strip).getAllByRole('button', { name: /详情/ });
    // The ring is the frame every rail item shares, so a balance keeps it — but with
    // no arc: any fill here would claim a percentage nothing measures. Its empty state
    // is the same one a quota falls back to when it has nothing to show.
    expect(deepseek!.querySelector('.minimal-ring-track')).not.toBeNull();
    expect(deepseek!.querySelector('.minimal-ring-arc')).toBeNull();
    expect(codex!.querySelector('.minimal-ring-arc')).not.toBeNull();
    expect(arcPercent(codex!)).toBeCloseTo(76, 1);
  });

  it('opens a platform card on hover, not on click', async () => {
    renderPanel({ client: client() });
    const codex = await ring(/Codex.*详情/);
    expect(card()).not.toBeInTheDocument();
    fireEvent.pointerOver(codex);
    const open = await screen.findByRole('dialog', { name: 'Codex 详情' });
    expect(open).toBeInTheDocument();
    expect(codex).toHaveAttribute('aria-expanded', 'true');
    expect(codex).toHaveAttribute('aria-controls', 'minimal-detail-codex');
  });

  it('follows the pointer between rings and leaves with it', async () => {
    const { container } = renderPanel({ client: client() });
    const codex = await ring(/Codex.*详情/);
    const glm = await ring(/GLM.*详情/);
    fireEvent.pointerOver(codex);
    await screen.findByRole('dialog', { name: 'Codex 详情' });
    fireEvent.pointerOver(glm);
    expect(await screen.findByRole('dialog', { name: 'GLM 详情' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Codex 详情' })).not.toBeInTheDocument();
    // Only the outer surface closes it: travelling from a ring into the card itself
    // is not leaving.
    fireEvent.pointerOver(screen.getByTestId('minimal-detail'));
    fireEvent.pointerOver(codex);
    expect(screen.getByRole('dialog', { name: 'GLM 详情' })).toBeInTheDocument();
    fireEvent.pointerOut(container.querySelector('.minimal-panel')!, { relatedTarget: document.body });
    await waitFor(() => expect(card()).not.toBeInTheDocument());
    // The frame itself outlives the card: it is the layer whose birth and death the
    // window cannot afford (see the helper above).
    expect(frame()).toHaveAttribute('aria-hidden', 'true');
  });

  it('anchors the card to the ring and points a caret at it', async () => {
    renderPanel({ client: client() });
    const glm = await ring(/GLM.*详情/);
    fireEvent.pointerOver(glm);
    const open = (await screen.findByTestId('minimal-detail')) as HTMLElement;
    expect(open.style.top).toMatch(/^\d+px$/);
    expect(open.style.getPropertyValue('--caret')).toMatch(/^\d+px$/);
    // It fades in rather than appearing: two frames after mount, so the browser has
    // something to transition from.
    await waitFor(() => expect(open.className).toContain('is-visible'));
  });

  it('renders the main panel’s own card, not a second presentation of it', async () => {
    // The detail hosts `ProviderCardView` — the identical component the overview
    // renders — so a row here is the row there. That is why the assertion is for the
    // card's own test id and its own building blocks rather than for a bespoke list.
    renderPanel({ client: client() });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    const detail = await screen.findByTestId('minimal-detail');
    const card = within(detail).getByTestId('card-codex');
    expect(card).toBeInTheDocument();
    expect(within(card).getByRole('region', { name: '主要指标' })).toBeInTheDocument();
    expect(within(card).getByText('5小时')).toBeInTheDocument();
    expect(card.querySelector('.quota-item')).not.toBeNull();
    // Its configuration entry is the card's own gear, in the card's own header.
    expect(within(card).getByRole('button', { name: '配置 Codex' })).toBeInTheDocument();
  });

  it('shows refresh, settings and pin on the focused rail', async () => {
    const { client: fake, host, onOpenSettings } = renderPanel({ client: client() });
    const strip = await rail();
    expect(within(strip).getByRole('button', { name: '设置' })).toBeEnabled();
    expect(within(strip).getByRole('button', { name: /刷新/ })).toBeEnabled();
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    const open = await screen.findByTestId('minimal-detail');
    fireEvent.click(within(open).getByRole('button', { name: '配置 Codex' }));
    expect(onOpenSettings).toHaveBeenCalledWith('codex');
    fireEvent.click(within(strip).getByRole('button', { name: '刷新全部平台' }));
    await waitFor(() => expect(fake.methodCalls('refresh').length).toBeGreaterThan(0));
    fireEvent.click(within(strip).getByRole('button', { name: '置顶面板' }));
    expect(host.onTogglePin).toHaveBeenCalled();
    fireEvent.click(within(strip).getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledWith('appearance');
  });

  it('names the monthly window in the card when no shorter window is trusted', async () => {
    const monthly = createFakeUsageClient({
      settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
      snapshot: snapshotOf([
        providerStateOf('glm', [
          metricOf({ key: 'quota.tools.monthly.remaining', unit: 'percent', direction: 'remaining', value: 91, connection: { provider: 'glm', connection: 'quota' } })
        ])
      ])
    });
    renderPanel({ client: monthly });
    const glm = await ring(/GLM.*详情/);
    expect(glm).toHaveTextContent('91%');
    expect(glm).not.toHaveTextContent('30d');
    fireEvent.pointerOver(glm);
    expect(within(await screen.findByTestId('card-glm')).getByText('月度')).toBeInTheDocument();
  });

  it('shows a neutral state rather than the placeholders the cards fall back to', async () => {
    // The full cards show invented numbers behind a glass cover when a provider has
    // no data. The rail has no cover to hide behind, so the missing value must never
    // reach the DOM at all — these are the card placeholders, spelled out.
    const empty = createFakeUsageClient({
      settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
      snapshot: snapshotOf([])
    });
    renderPanel({ client: empty });
    const strip = await rail();
    for (const placeholder of ['28%', '16%', '¥ 42.60', '¥42.60']) {
      expect(strip).not.toHaveTextContent(placeholder);
    }
    expect(within(strip).getAllByText('—')).toHaveLength(3);
    for (const provider of ['Codex', 'GLM', 'DeepSeek']) {
      // The state words live in the accessible name now, not on a second line the
      // 58-point column has no room for.
      expect(within(strip).getByRole('button', { name: new RegExp(`${provider}.*无数据`) })).toBeInTheDocument();
    }
  });

  it('closes the card on Escape and returns focus to its ring', async () => {
    // Escape dismisses the card and leaves the rail up, so the keyboard user has to
    // land back on the ring they were on — focus dropped to the body would put them
    // at the top of the document with no way back to the control they used.
    const { host } = renderPanel({ client: client() });
    const glm = await ring(/GLM.*详情/);
    fireEvent.pointerOver(glm);
    await screen.findByRole('dialog', { name: 'GLM 详情' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(card()).not.toBeInTheDocument());
    expect(document.activeElement).toBe(glm);
    expect(host.onRequestHide).not.toHaveBeenCalled();
  });

  it('opens the card for a keyboard user who activates the ring', async () => {
    // Enter and Space on a focused button are a `click`, so the keyboard path is the
    // same one touch takes — no hover required, and no separate focus behaviour that
    // would fight the focus Escape restores.
    renderPanel({ client: client() });
    const codex = await ring(/Codex.*详情/);
    codex.focus();
    expect(card()).not.toBeInTheDocument();
    fireEvent.click(codex);
    expect(await screen.findByRole('dialog', { name: 'Codex 详情' })).toBeInTheDocument();
  });

  it('closes the card on a tap outside it, for pointers that cannot hover', async () => {
    renderPanel({ client: client() });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByRole('dialog', { name: 'Codex 详情' });
    fireEvent.pointerDown(screen.getByTestId('minimal-panel'));
    await waitFor(() => expect(card()).not.toBeInTheDocument());
  });

  it('does not flash a platform card while the connection view fades out', async () => {
    // The card remembers what it was *about*, not just which platform was hovered
    // last: a remembered platform would come back for the length of the fade the
    // moment the connection view closed.
    const cached = providerStateOf('codex', [
      metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 8, windowSeconds: 18000 })
    ]);
    const errored = createFakeUsageClient({
      settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
      snapshot: snapshotOf([failedStateOf('codex', { kind: 'network', message: '连接失败', at: '2026-09-10T08:05:00.000Z' }, { snapshot: cached.snapshot })])
    });
    renderPanel({ client: errored });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByTestId('card-codex');
    fireEvent.click(screen.getByRole('button', { name: '连接异常 1' }));
    await screen.findByTestId('minimal-connection-body');
    fireEvent.click(screen.getByRole('button', { name: '连接异常 1' }));
    const closing = screen.getByTestId('minimal-detail');
    expect(within(closing).getByTestId('card-codex').closest('.minimal-detail-scroll')).toHaveAttribute('aria-hidden', 'true');
    expect(within(closing).getByTestId('minimal-connection-body').closest('.minimal-detail-scroll')).toHaveAttribute('aria-hidden', 'false');
  });

  it('measures the whole card while keeping actions on the rail', async () => {
    renderPanel({ client: client() });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    const detail = await screen.findByTestId('minimal-detail');
    const scroller = detail.querySelector('.minimal-detail-scroll.is-current');
    const content = scroller?.querySelector('.minimal-detail-content');
    expect(scroller).not.toBeNull();
    expect(content).not.toBeNull();
    expect(scroller!.contains(content!)).toBe(true);
    expect(content!.contains(screen.getByTestId('card-codex'))).toBe(true);
    expect(within(screen.getByTestId('minimal-rail')).getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('leaves the card alone when the window gains or loses focus', async () => {
    // A focus change is not a dismissal. Closing on blur made the card vanish the
    // moment the window lost focus and return when it was clicked again — a
    // disappear-and-reappear with nothing behind it.
    renderPanel({ client: client() });
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByTestId('card-codex');
    fireEvent.blur(window);
    fireEvent.focus(window);
    expect(screen.getByTestId('minimal-detail')).toBeInTheDocument();
    expect(screen.getByTestId('card-codex')).toBeInTheDocument();
  });

  it('asks the host for the rail width, then grows left for the card', async () => {
    const { host } = renderPanel({ client: client() });
    await rail();
    await waitFor(() =>
      expect(host.onSetMinimalLayout).toHaveBeenCalledWith(MINIMAL_RAIL_WIDTH, expect.any(Number), true)
    );
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await waitFor(() =>
      expect(host.onSetMinimalLayout).toHaveBeenCalledWith(
        MINIMAL_RAIL_DETAIL_WIDTH,
        expect.any(Number),
        false
      )
    );
    // Its own height channel is retired: two writers would fight over one frame.
    expect(host.onSetHeight).not.toHaveBeenCalled();
  });

  it('does not move the card when the rail’s action column unfolds', async () => {
    // The actions unroll a moment after the pointer arrives (the host polls the
    // cursor), and the connection badge appears with a failing connection — both while
    // a card is open. A placement clamped against either moved the card under the
    // reader's pointer, which is the jump seen entering and leaving the panel. The card
    // is placed from the card and the platforms, so the fold state cannot move it.
    const view = renderPanel({ client: client() });
    const glm = await ring(/GLM.*详情/);
    fireEvent.pointerOver(glm);
    const detail = await screen.findByTestId('minimal-detail');
    // jsdom lays nothing out, so the card's measured height is stubbed: the point here
    // is the clamp, and a clamp needs a card comparable in height to the rail.
    const scroller = detail.querySelector('.minimal-detail-scroll.is-current') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 198 });
    const hostWith = (headerVisible: boolean) => ({ ...view.host, headerVisible });
    const renderAt = (headerVisible: boolean) =>
      view.rerender(
        <PanelApp
          client={view.client}
          host={hostWith(headerVisible)}
          now={NOW}
          onOpenSettings={view.onOpenSettings}
        />
      );
    // A re-render re-measures and re-places (the placement effect has no dependency
    // list), so the two states are compared on the same stubbed card.
    renderAt(false);
    const placed = detail.style.top;
    const caret = detail.style.getPropertyValue('--caret');
    // Still pointing at the ring it belongs to: the caret is what makes a card that
    // had to be slid back inside the window say which platform it is about.
    const centre = centreOf(2);
    expect(Number.parseFloat(placed) + Number.parseFloat(caret)).toBeCloseTo(centre);
    renderAt(true);
    expect(detail.style.top).toBe(placed);
    expect(detail.style.getPropertyValue('--caret')).toBe(caret);
  });

  it('keeps the detail’s space until the card has finished fading out', async () => {
    // The width steps in one frame, so the frame it steps on is the whole question:
    // narrowing while the card is still fading would cut the fade off at the window
    // edge, which is the artefact the fixed-width card and the exit delay exist to
    // avoid. The rail width may only be asked for once the card is gone.
    const { host } = renderPanel({ client: client() });
    await rail();
    fireEvent.pointerOver(await ring(/Codex.*详情/));
    await screen.findByTestId('minimal-detail');
    await waitFor(() =>
      expect(host.onSetMinimalLayout).toHaveBeenLastCalledWith(
        MINIMAL_RAIL_DETAIL_WIDTH,
        expect.any(Number),
        false
      )
    );
    fireEvent.pointerOut(screen.getByTestId('minimal-panel'), { relatedTarget: document.body });
    // Still on its way out: the card is rendered and the last frame asked for is still
    // the wide one.
    expect(card()).toBeInTheDocument();
    expect(host.onSetMinimalLayout).toHaveBeenLastCalledWith(
      MINIMAL_RAIL_DETAIL_WIDTH,
      expect.any(Number),
      false
    );
    await waitFor(() => expect(card()).not.toBeInTheDocument());
    await waitFor(() =>
      expect(host.onSetMinimalLayout).toHaveBeenLastCalledWith(MINIMAL_RAIL_WIDTH, expect.any(Number), false)
    );
  });

  it('keeps connection failure text outside the platform card', async () => {
    const cached = providerStateOf('codex', [
      metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 8, windowSeconds: 18000, confidence: ['authoritative', 'stale'] })
    ]);
    const errored = createFakeUsageClient({
      settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
      snapshot: snapshotOf([failedStateOf('codex', { kind: 'network', message: '私有连接详情', at: '2026-09-10T08:05:00.000Z' }, { snapshot: cached.snapshot })])
    });
    renderPanel({ client: errored });
    const codex = await ring(/Codex.*详情/);
    expect(codex).toHaveAccessibleName(/已过期.*低额度/);
    fireEvent.pointerOver(codex);
    const platformCard = await screen.findByTestId('card-codex');
    // The card states the reminder in its accessible name and in the shared low
    // tone — it carries no reminder text of its own, and the detail invents none.
    expect(within(platformCard).getByLabelText(/低额度提醒/)).toBeInTheDocument();
    expect(within(platformCard).queryByText('私有连接详情')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '连接异常 1' }));
    const connection = await screen.findByTestId('minimal-connection-body');
    expect(connection).toHaveTextContent('私有连接详情');
    // The connection view is not a platform card, so the card's inset has to come from
    // its own frame (`.minimal-detail-connection`): the detail frame pads nothing.
    expect(connection.closest('.minimal-detail-connection')).not.toBeNull();
    // And the same rule holds for every view the detail can show, not just the one that
    // happens to be on screen: a platform card brings `.provider-card`, the connection
    // view brings its own frame, and the detail frame pads nothing at all. A child that
    // is neither is a view whose rows sit on the frame's edge.
    for (const content of document.querySelectorAll('.minimal-detail-content')) {
      for (const child of content.children) {
        expect(child.matches('.provider-card, .minimal-detail-connection'), `${child.className} brings no inset`).toBe(true);
      }
    }
  });
});
