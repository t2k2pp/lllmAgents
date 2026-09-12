import { describe, expect, it } from "vitest";
import { MCPClient } from "../../src/mcp/mcp-client.js";

describe("MCP tools discovery", () => {
  it("loads paginated tools and refreshes after a server notification", async () => {
    const script = `
      const readline = require('node:readline');
      let changed = false;
      const tool = name => ({name, inputSchema:{type:'object'}});
      const send = data => process.stdout.write(JSON.stringify(data)+'\\n');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line); if (!m.id) return;
        let result;
        if (m.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture'}};
        if (m.method === 'tools/list') result = changed ? {tools:[tool('new')]} : m.params.cursor ? {tools:[tool('second')]} : {tools:[tool('first')],nextCursor:'page2'};
        if (m.method === 'tools/call') { changed = true; result = {content:[{type:'text',text:'ok'}]}; send({jsonrpc:'2.0',method:'notifications/tools/list_changed'}); }
        send({jsonrpc:'2.0',id:m.id,result});
      });`;
    const client = new MCPClient({
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
    });
    try {
      await client.connect();
      expect(client.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
      const changed = new Promise<void>((resolve, reject) => {
        client.onToolsChanged = (error) => (error ? reject(error) : resolve());
      });
      await client.callTool({ name: "first" });
      await changed;
      expect(client.tools.map((tool) => tool.name)).toEqual(["new"]);
    } finally {
      await client.disconnect();
    }
  });
});
