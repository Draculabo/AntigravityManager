import { getPlatform } from '@/actions/app';
import { closeWindow, maximizeWindow, minimizeWindow } from '@/actions/window';
import { type ReactNode, useEffect, useState } from 'react';

interface DragWindowRegionProps {
  title?: ReactNode;
}

export default function DragWindowRegion({ title }: DragWindowRegionProps) {
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    getPlatform()
      .then((value) => {
        if (!active) {
          return;
        }
                       setPlatform(value);
      })
      .catch((error) => {
        console.error('Failed to detect platform', error);
      });

    return () => {
      active = false;
    };
  }, []);

  const isMacOS = platform === 'darwin';

  return (
    <div className="flex w-screen items-stretch justify-between">
      <div className="draglayer w-full">
        {title && !isMacOS && (
          <div className="flex flex-1 p-2 text-xs whitespace-nowrap text-gray-400 select-none">
            {title}
          </div>
        )}
        {isMacOS && (
          <div className="flex flex-1 p-2">
            {/* Maintain the same height but do not display content */}
          </div>
        )}
      </div>
      {!isMacOS && <WindowButtons />}
    </div>
  );
}

function WindowButtons() {
  return (
    <div className="flex">
      <button
        title="Minimize"
        type="button"
        className="p-2 hover:bg-slate-300"
        onClick={minimizeWindow}
      >
        <svg aria-hidden="true" role="img" width="12" height="12" viewBox="0 0 12 12">
          <rect fill="currentColor" width="10" height="1" x="1" y="6"></rect>
        </svg>
      </button>
      <button
        title="Maximize"
        type="button"
        className="p-2 hover:bg-slate-300"
        onClick={maximizeWindow}
      >
        <svg aria-hidden="true" role="img" width="12" height="12" viewBox="0 0 12 12">
          <rect width="9" height="9" x="1.5" y="1.5" fill="none" stroke="currentColor"></rect>
        </svg>
      </button>
      <button type="button" title="Close" className="p-2 hover:bg-red-300" onClick={closeWindow}>
        <svg aria-hidden="true" role="img" width="12" height="12" viewBox="0 0 12 12">
          <polygon
            fill="currentColor"
            fillRule="evenodd"
            points="11 1.576 6.583 6 11 10.424 10.424 11 6 6.583 1.576 11 1 10.424 5.417 6 1 1.576 1.576 1 6 5.417 10.424 1"
          ></polygon>
        </svg>
      </button>
    </div>
  );
}
