import { createAutomationWorker } from './worker';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

Deno.serve(createAutomationWorker({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}));
