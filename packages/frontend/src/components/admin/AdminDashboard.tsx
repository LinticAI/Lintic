import { useEffect, useState } from 'react';
import { AdminKeyProvider } from './AdminKeyContext.js';
import { AdminNav } from './AdminNav.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminSessions } from './AdminSessions.js';
import { AdminLinks } from './AdminLinks.js';
import { AdminTasks } from './AdminTasks.js';
import { AdminReviews } from './AdminReviews.js';
import { AdminSettings } from './AdminSettings.js';

export type AdminSection = 'overview' | 'sessions' | 'links' | 'tasks' | 'reviews' | 'settings';

function sectionFromPathname(pathname: string): AdminSection {
  if (pathname.startsWith('/admin/sessions')) return 'sessions';
  if (pathname.startsWith('/admin/links')) return 'links';
  if (pathname.startsWith('/admin/tasks')) return 'tasks';
  if (pathname.startsWith('/admin/reviews')) return 'reviews';
  if (pathname.startsWith('/admin/settings')) return 'settings';
  return 'overview';
}

interface AdminDashboardProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function AdminDashboard({ isDark, onToggleTheme }: AdminDashboardProps) {
  const [section, setSection] = useState<AdminSection>(() =>
    sectionFromPathname(window.location.pathname),
  );
  // For deep-linking into a review detail from other sections
  const [reviewDetailId, setReviewDetailId] = useState<string | null>(null);

  useEffect(() => {
    function handlePop() {
      setSection(sectionFromPathname(window.location.pathname));
    }
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  function navigate(nextSection: AdminSection, detailId?: string) {
    const path = nextSection === 'overview' ? '/admin' : `/admin/${nextSection}`;
    window.history.pushState({}, '', path);
    setSection(nextSection);
    setReviewDetailId(detailId ?? null);
  }

  // When navigating to reviews with a specific ID from another section
  function handleNavigate(sectionStr: string, id?: string) {
    const next = sectionStr as AdminSection;
    navigate(next, id);
  }

  return (
    <AdminKeyProvider>
      <div data-testid="admin-dashboard" className="flex h-screen overflow-hidden" style={{ background: 'var(--color-bg-app)' }}>
        <AdminNav
          section={section}
          onNavigate={(s) => navigate(s)}
          isDark={isDark}
          onToggleTheme={onToggleTheme}
        />

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Content */}
          <div className="min-h-0 flex-1 overflow-auto">
            {section === 'overview' && <AdminOverview onNavigate={handleNavigate} />}
            {section === 'sessions' && <AdminSessions onNavigate={handleNavigate} />}
            {section === 'links' && <AdminLinks onNavigate={handleNavigate} />}
            {section === 'tasks' && <AdminTasks />}
            {section === 'reviews' && (
              <AdminReviews
                initialSessionId={reviewDetailId}
                isDark={isDark}
                onToggleTheme={onToggleTheme}
              />
            )}
            {section === 'settings' && (
              <AdminSettings isDark={isDark} onToggleTheme={onToggleTheme} />
            )}
          </div>
        </main>
      </div>
    </AdminKeyProvider>
  );
}
