import React from 'react';
import DragWindowRegion from '@/components/drag-window-region';

export default function BaseLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DragWindowRegion title="Antigravity Manager" />
      <main className="h-screen p-2 pb-20">{children}</main>
    </>
  );
}
