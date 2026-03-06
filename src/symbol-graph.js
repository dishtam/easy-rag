/**
 * Symbol Graph
 *
 * Tracks:
 *   - which files import which other files
 *   - which symbols are exported from each file
 *   - call references (function names mentioned in a chunk's body)
 *
 * This lets us do "graph expansion": when you retrieve chunk A,
 * also pull in chunks from files that A imports, or files that export
 * a symbol that A references — just like Copilot's reference tracking.
 */

export class SymbolGraph {
  constructor() {
    // fileA → Set<fileB>  (fileA imports fileB)
    this.imports = {};
    // fileB → Set<fileA>  (fileA imports fileB = fileB is imported by fileA)
    this.importedBy = {};
    // symbolName → filePath
    this.symbolToFile = {};
    // filePath → [symbolName]
    this.fileToSymbols = {};
  }

  /**
   * Build graph from indexed chunks.
   */
  build(chunks) {
    // First pass: register all exported symbols
    for (const chunk of chunks) {
      const { filePath, symbolName, exports: exps } = chunk;

      if (!this.fileToSymbols[filePath]) this.fileToSymbols[filePath] = [];

      if (symbolName) {
        this.symbolToFile[symbolName.toLowerCase()] = filePath;
        this.fileToSymbols[filePath].push(symbolName);
      }

      if (exps) {
        for (const exp of exps) {
          this.symbolToFile[exp.toLowerCase()] = filePath;
        }
      }
    }

    // Second pass: resolve imports to actual file paths
    for (const chunk of chunks) {
      const { filePath, imports: imps } = chunk;
      if (!imps || imps.length === 0) continue;
      if (!this.imports[filePath]) this.imports[filePath] = new Set();

      for (const imp of imps) {
        // Resolve relative imports (./foo, ../bar/baz)
        const resolved = this._resolveImport(filePath, imp, chunks);
        if (resolved) {
          this.imports[filePath].add(resolved);
          if (!this.importedBy[resolved]) this.importedBy[resolved] = new Set();
          this.importedBy[resolved].add(filePath);
        }
      }
    }
  }

  _resolveImport(fromFile, importPath, chunks) {
    // Only try to resolve relative imports
    if (!importPath.startsWith('.')) return null;

    const dir = fromFile.split('/').slice(0, -1).join('/');
    const base = importPath.replace(/^\.\//, '').replace(/^\.\.\//, '../');

    // Try with common extensions
    const candidates = [
      `${dir}/${base}`,
      `${dir}/${base}.js`,
      `${dir}/${base}.ts`,
      `${dir}/${base}.jsx`,
      `${dir}/${base}.tsx`,
      `${dir}/${base}/index.js`,
      `${dir}/${base}/index.ts`,
    ].map(p => p.replace(/\/\.\.\//g, '/').replace(/\/\.\//g, '/'));

    const allFiles = new Set(chunks.map(c => c.filePath));
    return candidates.find(c => allFiles.has(c)) || null;
  }

  /**
   * Get files that the given file directly imports.
   */
  getImports(filePath) {
    return [...(this.imports[filePath] || [])];
  }

  /**
   * Get files that import the given file.
   */
  getImportedBy(filePath) {
    return [...(this.importedBy[filePath] || [])];
  }

  /**
   * Find which file defines a given symbol name.
   */
  findSymbolFile(symbolName) {
    return this.symbolToFile[symbolName.toLowerCase()] || null;
  }

  /**
   * Given a query string, find symbol references within it.
   * Returns file paths of files that export those symbols.
   */
  findReferencedFiles(query) {
    const words = query
      .split(/[^a-zA-Z0-9_]+/)
      .filter(w => w.length > 2)
      .map(w => w.toLowerCase());

    const files = new Set();
    for (const word of words) {
      const file = this.symbolToFile[word];
      if (file) files.add(file);
    }
    return [...files];
  }

  /**
   * Expand a set of result files by 1 hop in the import graph.
   * Returns additional file paths that are closely related.
   */
  expandContext(filePaths, maxExpansion = 3) {
    const extra = new Set();
    const source = new Set(filePaths);

    for (const fp of filePaths) {
      // Files this file imports
      for (const imp of this.getImports(fp)) {
        if (!source.has(imp)) extra.add(imp);
      }
      // Files that import this file (callers)
      for (const caller of this.getImportedBy(fp)) {
        if (!source.has(caller)) extra.add(caller);
      }
    }

    return [...extra].slice(0, maxExpansion);
  }

  serialize() {
    return {
      imports: Object.fromEntries(
        Object.entries(this.imports).map(([k, v]) => [k, [...v]])
      ),
      importedBy: Object.fromEntries(
        Object.entries(this.importedBy).map(([k, v]) => [k, [...v]])
      ),
      symbolToFile: this.symbolToFile,
      fileToSymbols: this.fileToSymbols,
    };
  }

  load(data) {
    this.imports = Object.fromEntries(
      Object.entries(data.imports || {}).map(([k, v]) => [k, new Set(v)])
    );
    this.importedBy = Object.fromEntries(
      Object.entries(data.importedBy || {}).map(([k, v]) => [k, new Set(v)])
    );
    this.symbolToFile = data.symbolToFile || {};
    this.fileToSymbols = data.fileToSymbols || {};
  }
}
