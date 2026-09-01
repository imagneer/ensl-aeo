'use client';

import { useState } from 'react';

export function HeadlineEvidenceToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="evidence-btn" onClick={() => setOpen((v) => !v)}>
        {open ? '근거 접기 ↑' : '이 한 줄의 근거 보기 →'}
      </button>
      <div className="evidence-panel" hidden={!open}>
        {children}
      </div>
    </>
  );
}
