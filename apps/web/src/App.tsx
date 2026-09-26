import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './ui.js';
import { ConsiderPage } from './pages/ConsiderPage.js';
import { DecidePage } from './pages/DecidePage.js';
import { DecisionPage } from './pages/DecisionPage.js';
import { EvidencePage } from './pages/EvidencePage.js';
import { ExplorePage } from './pages/ExplorePage.js';
import { NeedPage } from './pages/NeedPage.js';
import { ProviderPage } from './pages/ProviderPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate replace to="/decide" />} />
        <Route path="decide" element={<DecidePage />} />
        <Route path="decide/:id" element={<NeedPage />} />
        <Route path="decisions/:id" element={<DecisionPage />} />
        <Route path="explore" element={<ExplorePage />} />
        <Route path="providers/:id" element={<ProviderPage />} />
        <Route path="consider" element={<ConsiderPage />} />
        <Route path="evidence" element={<EvidencePage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="*" element={<Navigate replace to="/decide" />} />
      </Route>
    </Routes>
  );
}
