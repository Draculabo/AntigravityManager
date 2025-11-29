import { MainLayout } from "@/layouts/MainLayout";
import { createRootRoute } from "@tanstack/react-router";
/* import { TanStackRouterDevtools } from '@tanstack/react-router-devtools' */

/*
 * Uncomment the code in this file to enable the router devtools.
 */

function Root() {
  return (
    <MainLayout>
      {/* Uncomment the following line to enable the router devtools */}
      {/* <TanStackRouterDevtools /> */}
    </MainLayout>
  );
}

export const Route = createRootRoute({
  component: Root,
});
