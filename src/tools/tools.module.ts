import { Global, Module } from '@nestjs/common';
import { AddNumbersTool } from './builtin/add-numbers.tool';
import { GetCurrentTimeTool } from './builtin/get-current-time.tool';
import { SearchWebTool } from './builtin/search-web.tool';
import { ToolRegistry } from './tool-registry';

@Global()
@Module({
  providers: [
    ToolRegistry,
    GetCurrentTimeTool,
    AddNumbersTool,
    SearchWebTool,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
