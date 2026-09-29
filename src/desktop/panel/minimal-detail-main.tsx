import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../panel.css';
import { createDesktopUsageClient, detectDesktopBridge } from '../lib/desktop-client';
import { MinimalDetailWindow } from './MinimalDetailWindow';

const root = document.getElementById('minimal-detail-root');
const bridge = detectDesktopBridge();
if (root && bridge) {
  createRoot(root).render(createElement(MinimalDetailWindow, { client: createDesktopUsageClient(), bridge }));
}
