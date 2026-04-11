import type { AdminAssessmentLinkSummary } from '@lintic/core';

export type AssessmentDisplayStatus =
  | 'not_opened'
  | 'in_progress'
  | 'submitted'
  | 'expired'
  | 'invalid';

export function getAssessmentDisplayStatus(
  link: Pick<AdminAssessmentLinkSummary, 'status' | 'consumed_session_id' | 'session_status'>,
): AssessmentDisplayStatus {
  if (link.status === 'invalid') return 'invalid';
  if (link.status === 'expired') return 'expired';
  if (!link.consumed_session_id) return 'not_opened';
  if (link.session_status === 'expired') return 'expired';
  if (link.session_status === 'active') return 'in_progress';
  return 'submitted';
}

export function getAssessmentStatusLabel(
  link: Pick<AdminAssessmentLinkSummary, 'status' | 'consumed_session_id' | 'session_status'>,
): string {
  const displayStatus = getAssessmentDisplayStatus(link);

  switch (displayStatus) {
    case 'not_opened':
      return 'Not Opened';
    case 'in_progress':
      return 'In Progress';
    case 'submitted':
      return 'Submitted';
    case 'expired':
      return 'Expired';
    case 'invalid':
      return 'Invalid';
  }
}

export const ASSESSMENT_STATUS_DOT: Record<AssessmentDisplayStatus, string> = {
  not_opened: 'var(--color-text-dimmest)',
  in_progress: 'var(--color-brand)',
  submitted: 'var(--color-status-success)',
  expired: 'var(--color-status-warning)',
  invalid: 'var(--color-status-error)',
};
