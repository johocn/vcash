import type { CodegenConfig } from '@graphql-codegen/cli';

export default {
  schema: 'http://localhost:3000/admin-api',
  documents: ['src/api/operations/**/*.graphql'],
  generates: { 'src/api/types.ts': { preset: 'client' } },
} satisfies CodegenConfig;
