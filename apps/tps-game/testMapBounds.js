import { readFileSync } from "fs";
import { extractMeshFromGLBAsync, detectDracoInGLB } from "./src/physics/GLBLoader.js";

async function analyzeMap() {
  const filepath = "apps/tps-game/schwust.glb";
  
  // First check compression type
  const compression = detectDracoInGLB(filepath);
  console.log("Compression:", compression);
  
  const buf = readFileSync(filepath);
  if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("Not a GLB file");
  
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf-8", 20, 20 + jsonLen));
  
  console.log("Map has", json.meshes?.length || 0, "meshes");
  console.log("Map has", json.nodes?.length || 0, "nodes");
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  // Extract vertices from all meshes
  for (let i = 0; i < (json.meshes?.length || 0); i++) {
    try {
      console.log("Extracting mesh " + i + "...");
      const mesh = await extractMeshFromGLBAsync(filepath, i);
      
      // Apply node transform if available
      const node = json.nodes?.find(n => n.mesh === i);
      if (node) {
        const scale = node.scale ? [node.scale[0], node.scale[1], node.scale[2]] : [1, 1, 1];
        const translation = node.translation ? [node.translation[0], node.translation[1], node.translation[2]] : [0, 0, 0];
        
        // Apply transform to vertices
        for (let j = 0; j < mesh.vertices.length / 3; j++) {
          let x = mesh.vertices[j * 3] * scale[0];
          let y = mesh.vertices[j * 3 + 1] * scale[1];
          let z = mesh.vertices[j * 3 + 2] * scale[2];
          
          if (node.rotation) {
            const [qx, qy, qz, qw] = node.rotation;
            const ix = qw * x + qy * z - qz * y;
            const iy = qw * y + qz * x - qx * z;
            const iz = qw * z + qx * y - qy * x;
            const iw = -qx * x - qy * y - qz * z;
            
            x = ix * qw - iw * qx - iy * qz + iz * qy;
            y = iy * qw - iw * qy - iz * qx + ix * qz;
            z = iz * qw - iw * qz - ix * qy + iy * qx;
          }
          
          x += translation[0];
          y += translation[1];
          z += translation[2];
          
          mesh.vertices[j * 3] = x;
          mesh.vertices[j * 3 + 1] = y;
          mesh.vertices[j * 3 + 2] = z;
        }
      }
      
      // Find min/max coordinates
      for (let j = 0; j < mesh.vertices.length / 3; j++) {
        const x = mesh.vertices[j * 3];
        const y = mesh.vertices[j * 3 + 1];
        const z = mesh.vertices[j * 3 + 2];
        
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      
      console.log("  Mesh " + i + " (" + mesh.name + "): " + mesh.vertexCount + " vertices");
    } catch (err) {
      console.error("  Failed to extract mesh " + i + ": " + err.message);
    }
  }
  
  console.log("\n=== Map Bounding Box ===");
  console.log("X: " + minX.toFixed(2) + " to " + maxX.toFixed(2) + " (" + (maxX - minX).toFixed(2) + " units wide)");
  console.log("Y: " + minY.toFixed(2) + " to " + maxY.toFixed(2) + " (" + (maxY - minY).toFixed(2) + " units tall)");
  console.log("Z: " + minZ.toFixed(2) + " to " + maxZ.toFixed(2) + " (" + (maxZ - minZ).toFixed(2) + " units deep)");
  
  console.log("\n=== Center Coordinates ===");
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  console.log("Center: [" + centerX.toFixed(2) + ", " + centerY.toFixed(2) + ", " + centerZ.toFixed(2) + "]");
  
  console.log("\n=== Suggested Spawn Point Range ===");
  console.log("X range: " + minX.toFixed(2) + " to " + maxX.toFixed(2));
  console.log("Z range: " + minZ.toFixed(2) + " to " + maxZ.toFixed(2));
  console.log("Y offset: 2-3 units above ground (" + minY.toFixed(2) + " + 2 = " + (minY + 2).toFixed(2) + ")");
}

analyzeMap().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
