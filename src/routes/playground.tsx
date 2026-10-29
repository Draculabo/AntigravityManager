import { createFileRoute } from '@tanstack/react-router';
import { PlaygroundPage } from '@/modules/proxy-gateway/playground/PlaygroundPage';

export const Route = createFileRoute('/playground')({
  component: PlaygroundPage,
});
