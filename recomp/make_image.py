#!/usr/bin/env python3
"""Regenerate image.bin (memory-mapped PE image) and meta.json (base, entry, import table) from the user's MnMs.exe."""
import sys, json, pefile
pe = pefile.PE(sys.argv[1] if len(sys.argv) > 1 else 'MnMs.exe')
open('image.bin', 'wb').write(pe.get_memory_mapped_image())
imps = [[imp.address, imp.name.decode()] for e in pe.DIRECTORY_ENTRY_IMPORT for imp in e.imports]
base = pe.OPTIONAL_HEADER.ImageBase
json.dump(dict(base=base, entry=base + pe.OPTIONAL_HEADER.AddressOfEntryPoint, imports=imps), open('meta.json', 'w'))
print(len(imps), 'imports; image', len(pe.get_memory_mapped_image()), 'bytes')
