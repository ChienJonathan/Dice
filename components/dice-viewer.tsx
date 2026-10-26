"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as CANNON from "cannon-es";
import { Loader2, RotateCcw, Sparkles, Smartphone, Vibrate, Check } from "lucide-react";

// D6 各面在模型本機座標中的法向量 (實測 D6.glb 幾何)
const D6_FACES = [
  { value: 1, vector: new THREE.Vector3(0, 1, 0) },
  { value: 6, vector: new THREE.Vector3(0, -1, 0) },
  { value: 2, vector: new THREE.Vector3(0, 0, -1) },
  { value: 5, vector: new THREE.Vector3(0, 0, 1) },
  { value: 3, vector: new THREE.Vector3(-1, 0, 0) },
  { value: 4, vector: new THREE.Vector3(1, 0, 0) },
];

function getRolledFace(quat: THREE.Quaternion): number {
  let maxDot = -Infinity;
  let result = 1;
  const up = new THREE.Vector3(0, 1, 0);

  for (const f of D6_FACES) {
    const worldVec = f.vector.clone().applyQuaternion(quat);
    const dot = worldVec.dot(up);
    if (dot > maxDot) {
      maxDot = dot;
      result = f.value;
    }
  }
  return result;
}

// 根據螢幕長寬比計算最佳俯視高度 (特別在手機直向螢幕自動拉高鏡頭，確保足夠寬廣的投骰空間)
function getOptimalCameraY(aspect: number): number {
  const tanHalfFov = Math.tan((45 * Math.PI) / 360);
  const yNeededForWidth = 9.5 / (2 * tanHalfFov * aspect);
  return Math.max(15, Math.min(yNeededForWidth, 23));
}

interface DiceItem {
  mesh: THREE.Group;
  body: CANNON.Body;
}

export function DiceViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  // 物理與模型參照 (支援多顆骰子)
  const worldRef = useRef<CANNON.World | null>(null);
  const dicesRef = useRef<DiceItem[]>([]);
  const wallsRef = useRef<{
    left: CANNON.Body;
    right: CANNON.Body;
    top: CANNON.Body;
    bottom: CANNON.Body;
  } | null>(null);

  // IMU 體感控制相關狀態與 Ref
  const [imuSupported, setImuSupported] = useState(false);
  const [imuEnabled, setImuEnabled] = useState(false);
  const imuActiveRef = useRef(false);
  const targetGravityRef = useRef<{ x: number; z: number }>({ x: 0, z: 0 });

  // 即時遙測數據 (顯示於左下角)
  const [accZ, setAccZ] = useState(0);
  const [effG, setEffG] = useState(1.0);
  const effGRef = useRef(1.0);
  const lastUiUpdateTimeRef = useRef(0);

  // 狀態
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [rolledNumbers, setRolledNumbers] = useState<number[] | null>(null);
  const [isRolling, setIsRolling] = useState(false);

  // 滾動計時防抖
  const rollingStateRef = useRef(false);
  const rollStartTimeRef = useRef(0);

  // 擲骰動作 (原地起飛：保持骰子當前地面位置直接向上拋擲翻滾)
  const rollDice = useCallback((intensityMultiplier: number = 1.0) => {
    const dices = dicesRef.current;
    if (dices.length === 0) return;

    rollingStateRef.current = true;
    rollStartTimeRef.current = performance.now();
    setIsRolling(true);
    setRolledNumbers(null);

    const mult = Math.max(0.8, Math.min(2.5, intensityMultiplier));

    // 模擬遙測數據突波 (方便電腦端按空白鍵也能看到 g<0 與原地起飛效果)
    effGRef.current = -0.85 * mult;
    setEffG(-0.85 * mult);
    setAccZ(-18.2 * mult);
    setTimeout(() => {
      effGRef.current = 1.0;
      setEffG(1.0);
      setAccZ(0);
    }, 400);

    // 依序在當前所在位置原地向上爆發拋起
    dices.forEach((dice) => {
      dice.body.velocity.set(
        (Math.random() - 0.5) * 6 * mult,
        (7.5 + Math.random() * 4.5) * mult,
        (Math.random() - 0.5) * 6 * mult
      );

      // 強烈隨機角速度翻滾
      dice.body.angularVelocity.set(
        (Math.random() - 0.5) * 55 * mult,
        (Math.random() - 0.5) * 55 * mult,
        (Math.random() - 0.5) * 55 * mult
      );

      dice.body.wakeUp();
    });
  }, []);

  // 空白鍵監聽
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        rollDice(1.0);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [rollDice]);

  // 偵測裝置是否支援 IMU
  useEffect(() => {
    if (typeof window !== "undefined") {
      const hasMotion = "DeviceMotionEvent" in window;
      const hasOrientation = "DeviceOrientationEvent" in window;
      setImuSupported(hasMotion || hasOrientation);
    }
  }, []);

  // 啟用 / 請求 IMU 權限
  const toggleIMU = async () => {
    if (imuEnabled) {
      setImuEnabled(false);
      imuActiveRef.current = false;
      targetGravityRef.current = { x: 0, z: 0 };
      return;
    }

    try {
      // iOS 13+ 需要使用者點擊手勢明確請求權限
      if (
        typeof DeviceMotionEvent !== "undefined" &&
        typeof (DeviceMotionEvent as any).requestPermission === "function"
      ) {
        const motionRes = await (DeviceMotionEvent as any).requestPermission();
        if (motionRes !== "granted") {
          alert("未取得動作感應器權限，無法使用搖晃擲骰功能。");
          return;
        }
      }

      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof (DeviceOrientationEvent as any).requestPermission === "function"
      ) {
        await (DeviceOrientationEvent as any).requestPermission();
      }

      setImuEnabled(true);
      imuActiveRef.current = true;

      // 成功啟用震動提醒
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate([30, 50, 30]);
      }
    } catch (err) {
      console.error("請求 IMU 權限失敗:", err);
      // Android 或標準環境通常直接啟用
      setImuEnabled(true);
      imuActiveRef.current = true;
    }
  };

  // IMU 感應器事件監聽 (加速計搖晃 & 陀螺儀傾斜)
  useEffect(() => {
    if (!imuEnabled) return;

    let lastX = 0;
    let lastY = 0;
    let lastZ = 0;
    let lastShakeTime = 0;

    // 1. 加速計：偵測 Z 軸加速度、計算有效重力 g 與原地起飛
    const handleMotion = (event: DeviceMotionEvent) => {
      const linZ = event.acceleration?.z ?? 0;
      const gravZ = event.accelerationIncludingGravity?.z;

      // 當前包含重力的 Z 軸總加速度 (m/s²)
      const currentGz = gravZ !== null && gravZ !== undefined ? gravZ : (9.8 + linZ);

      // 有效重力 g (以 1.0G = 9.8m/s² 為標準)
      const calculatedG = currentGz / 9.8;
      effGRef.current = calculatedG;

      // 更新左下角 UI 數據 (約 15Hz 頻率)
      const now = performance.now();
      if (now - lastUiUpdateTimeRef.current > 60) {
        lastUiUpdateTimeRef.current = now;
        setAccZ(linZ);
        setEffG(calculatedG);
      }

      // --- 核心物理：地板跟著手機動，g < 0 原地起飛 ---
      if (calculatedG < 0) {
        // 當 g < 0 (向下抽動或向上急停)，骰子相對於手機地板獲得向上衝量原地起飛！
        const liftImpulse = Math.min(18, Math.abs(calculatedG) * 12 + 5.0);

        dicesRef.current.forEach((dice) => {
          // 在原本位置原地向上爆發
          if (dice.body.position.y <= 1.0) {
            dice.body.velocity.y = Math.max(dice.body.velocity.y, liftImpulse);
            dice.body.velocity.x += (Math.random() - 0.5) * 4;
            dice.body.velocity.z += (Math.random() - 0.5) * 4;
            dice.body.angularVelocity.x += (Math.random() - 0.5) * 45;
            dice.body.angularVelocity.y += (Math.random() - 0.5) * 45;
            dice.body.angularVelocity.z += (Math.random() - 0.5) * 45;
            dice.body.wakeUp();
          }
        });

        if (!rollingStateRef.current) {
          rollingStateRef.current = true;
          rollStartTimeRef.current = now;
          setIsRolling(true);
          setRolledNumbers(null);
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            try {
              navigator.vibrate(35);
            } catch {}
          }
        }
      }

      // 橫向強烈晃動輔助擲骰
      const acc = event.acceleration || event.accelerationIncludingGravity;
      if (acc) {
        const x = acc.x || 0;
        const y = acc.y || 0;
        const z = linZ;
        const delta = Math.abs(x - lastX) + Math.abs(y - lastY) + Math.abs(z - lastZ);
        lastX = x;
        lastY = y;
        lastZ = z;

        if (delta > 26 && now - lastShakeTime > 750) {
          lastShakeTime = now;
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            navigator.vibrate([40, 60, 40]);
          }
          const intensity = Math.min(2.2, delta / 18);
          rollDice(intensity);
        }
      }
    };

    // 2. 陀螺儀：偵測手機傾斜 (傾斜重力場動態滾動)
    const handleOrientation = (event: DeviceOrientationEvent) => {
      const gamma = event.gamma; // 左右傾斜 [-90, 90]
      const beta = event.beta;   // 前後傾斜 [-180, 180]
      if (gamma === null || beta === null) return;

      // 基準角度校準：手持手機正視時通常傾斜約 40 度
      const targetGx = Math.sin((gamma * Math.PI) / 180) * 22;
      const targetGz = Math.sin(((beta - 40) * Math.PI) / 180) * 22;

      targetGravityRef.current.x = Math.max(-18, Math.min(18, targetGx));
      targetGravityRef.current.z = Math.max(-18, Math.min(18, targetGz));
    };

    window.addEventListener("devicemotion", handleMotion);
    window.addEventListener("deviceorientation", handleOrientation);

    return () => {
      window.removeEventListener("devicemotion", handleMotion);
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, [imuEnabled, rollDice]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- 1. Cannon.js 物理世界設定 ---
    const world = new CANNON.World();
    world.gravity.set(0, -22, 0); // 爽快的重力加速度
    world.allowSleep = true;
    worldRef.current = world;

    // 材質與碰撞反彈
    const dicePhysMat = new CANNON.Material("dice");
    const floorPhysMat = new CANNON.Material("floor");
    const wallPhysMat = new CANNON.Material("wall");

    // 骰子與地面
    const diceFloorContact = new CANNON.ContactMaterial(dicePhysMat, floorPhysMat, {
      friction: 0.35,
      restitution: 0.45,
    });
    world.addContactMaterial(diceFloorContact);

    // 骰子與牆壁
    const diceWallContact = new CANNON.ContactMaterial(dicePhysMat, wallPhysMat, {
      friction: 0.2,
      restitution: 0.6,
    });
    world.addContactMaterial(diceWallContact);

    // 骰子互相碰撞反彈
    const diceDiceContact = new CANNON.ContactMaterial(dicePhysMat, dicePhysMat, {
      friction: 0.3,
      restitution: 0.5,
    });
    world.addContactMaterial(diceDiceContact);

    // 地面剛體 (y = 0 平面)
    const floorBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
      material: floorPhysMat,
    });
    floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    floorBody.position.set(0, 0, 0);
    world.addBody(floorBody);

    // 建立 2 顆骰子的物理剛體 (尺寸 1.2，半長 0.6)
    const halfSize = 0.6;
    const initialPositions = [
      new CANNON.Vec3(-1.3, 0.6, 0),
      new CANNON.Vec3(1.3, 0.6, 0),
    ];

    const diceBodies: CANNON.Body[] = [];
    initialPositions.forEach((pos) => {
      const body = new CANNON.Body({
        mass: 1.0,
        shape: new CANNON.Box(new CANNON.Vec3(halfSize, halfSize, halfSize)),
        material: dicePhysMat,
        linearDamping: 0.12,
        angularDamping: 0.15,
      });
      body.position.copy(pos);

      // 物理碰撞微震動反饋 (骰子落地/撞牆/互撞時產生真實觸覺)
      body.addEventListener("collide", (e: any) => {
        const relVel = e.contact?.getImpactVelocityAlongNormal?.() ?? 0;
        if (Math.abs(relVel) > 2.5) {
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            try {
              navigator.vibrate(Math.min(25, Math.floor(Math.abs(relVel) * 2)));
            } catch {}
          }
        }
      });

      world.addBody(body);
      diceBodies.push(body);
    });

    // 視窗邊界隱形牆
    const createWall = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      const wall = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(sx, sy, sz)),
        material: wallPhysMat,
      });
      wall.position.set(x, y, z);
      world.addBody(wall);
      return wall;
    };

    const leftWall = createWall(-12, 8, 0, 0.5, 16, 60);
    const rightWall = createWall(12, 8, 0, 0.5, 16, 60);
    const topWall = createWall(0, 8, -12, 60, 16, 0.5);
    const bottomWall = createWall(0, 8, 12, 60, 16, 0.5);
    wallsRef.current = { left: leftWall, right: rightWall, top: topWall, bottom: bottomWall };

    // --- 2. Three.js 場景設定 ---
    const scene = new THREE.Scene();

    const initialAspect = container.clientWidth / container.clientHeight;
    const initialY = getOptimalCameraY(initialAspect);

    // 攝影機 - 正上方俯視
    const camera = new THREE.PerspectiveCamera(
      45,
      initialAspect,
      0.1,
      1000
    );
    camera.position.set(0, initialY, 0.001);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // 渲染器
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    // 控制器
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = false;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 光照
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.35);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.2);
    dirLight1.position.set(8, 28, 8);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 2048;
    dirLight1.shadow.mapSize.height = 2048;
    dirLight1.shadow.camera.near = 1;
    dirLight1.shadow.camera.far = 60;
    dirLight1.shadow.camera.left = -22;
    dirLight1.shadow.camera.right = 22;
    dirLight1.shadow.camera.top = 22;
    dirLight1.shadow.camera.bottom = -22;
    dirLight1.shadow.bias = -0.0003;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xdbeafe, 0.7);
    dirLight2.position.set(-8, 22, -8);
    scene.add(dirLight2);

    // 地面陰影接收網格
    const shadowPlaneGeo = new THREE.PlaneGeometry(100, 100);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.001;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // --- 3. 載入 D6.glb 模型並實例化 2 顆骰子 (支援 basePath 靜態匯出相容) ---
    const loader = new GLTFLoader();
    const diceItems: DiceItem[] = [];

    const loadModel = (url: string, fallbackUrl?: string) => {
      loader.load(
        url,
        (gltf) => {
          const baseScene = gltf.scene;

          for (let i = 0; i < 2; i++) {
            const meshGroup = baseScene.clone(true);
            meshGroup.scale.set(1.2, 1.2, 1.2);

            meshGroup.traverse((child) => {
              if ((child as THREE.Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });

            meshGroup.position.copy(diceBodies[i].position as unknown as THREE.Vector3);
            meshGroup.quaternion.copy(diceBodies[i].quaternion as unknown as THREE.Quaternion);

            scene.add(meshGroup);
            diceItems.push({ mesh: meshGroup, body: diceBodies[i] });
          }

          dicesRef.current = diceItems;
          setLoading(false);
        },
        (xhr) => {
          if (xhr.total > 0) {
            setProgress(Math.round((xhr.loaded / xhr.total) * 100));
          }
        },
        (error) => {
          if (fallbackUrl) {
            loadModel(fallbackUrl);
          } else {
            console.error("Error loading D6.glb:", error);
            setLoading(false);
          }
        }
      );
    };

    loadModel("/dice/D6.glb", "/D6.glb");

    // --- 4. 視窗自適應 & 邊界牆計算 ---
    const updateBounds = () => {
      if (!container) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      const aspect = width / height;
      camera.aspect = aspect;

      const optimalY = getOptimalCameraY(aspect);
      camera.position.set(0, optimalY, 0.001);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);

      const visibleH = 2 * camera.position.y * Math.tan((camera.fov * Math.PI) / 360);
      const visibleW = visibleH * camera.aspect;

      const boundX = Math.max(visibleW / 2 - 0.7, 3.0);
      const boundZ = Math.max(visibleH / 2 - 0.7, 3.0);

      if (wallsRef.current) {
        wallsRef.current.left.position.x = -boundX;
        wallsRef.current.right.position.x = boundX;
        wallsRef.current.top.position.z = -boundZ;
        wallsRef.current.bottom.position.z = boundZ;
      }
    };

    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(container);
    updateBounds();

    // --- 5. 動畫與物理步進循環 ---
    let animationFrameId: number;
    let lastTime = performance.now();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // IMU 傾斜與垂直動態重力場補間平滑過渡
      if (imuActiveRef.current) {
        world.gravity.x += (targetGravityRef.current.x - world.gravity.x) * 0.15;
        world.gravity.z += (targetGravityRef.current.z - world.gravity.z) * 0.15;

        // 垂直重力：隨有效重力 g 比例動態縮放 (g < 0 時產生向上的升力)
        const targetGy = -22 * Math.max(-1.5, Math.min(2.5, effGRef.current));
        world.gravity.y += (targetGy - world.gravity.y) * 0.2;

        // 當傾斜或失重時喚醒骰子
        const tiltMag = Math.hypot(world.gravity.x, world.gravity.z);
        if (tiltMag > 3.0 || effGRef.current < 0.2) {
          dicesRef.current.forEach((d) => d.body.wakeUp());
        }
      } else {
        // 未開啟體感時重力回歸標準值
        world.gravity.x += (0 - world.gravity.x) * 0.1;
        world.gravity.z += (0 - world.gravity.z) * 0.1;
        world.gravity.y += (-22 - world.gravity.y) * 0.1;
      }

      // 物理世界運算
      world.step(1 / 60, dt, 3);

      // 同步 2 顆骰子模型與剛體
      let allSettled = true;
      const currentFaces: number[] = [];

      for (const item of dicesRef.current) {
        item.mesh.position.copy(item.body.position as unknown as THREE.Vector3);
        item.mesh.quaternion.copy(item.body.quaternion as unknown as THREE.Quaternion);

        const speed = item.body.velocity.length();
        const angSpeed = item.body.angularVelocity.length();

        if (speed > 0.08 || angSpeed > 0.08 || item.body.position.y > 0.85) {
          allSettled = false;
        }

        const q = new THREE.Quaternion(
          item.body.quaternion.x,
          item.body.quaternion.y,
          item.body.quaternion.z,
          item.body.quaternion.w
        );
        currentFaces.push(getRolledFace(q));
      }

      // 當翻滾經過 600ms 且兩顆骰子皆靜止在地面
      if (rollingStateRef.current && dicesRef.current.length === 2) {
        const elapsed = now - rollStartTimeRef.current;
        if (elapsed > 600 && allSettled) {
          rollingStateRef.current = false;
          setIsRolling(false);
          setRolledNumbers(currentFaces);
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // 清理資源
    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      controls.dispose();

      scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((mat) => mat.dispose());
          } else {
            mesh.material?.dispose();
          }
        }
      });

      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  const resetToTopDownView = () => {
    if (controlsRef.current && cameraRef.current && containerRef.current) {
      const aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      const targetY = getOptimalCameraY(aspect);
      cameraRef.current.position.set(0, targetY, 0.001);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden select-none bg-stone-100">
      {/* 3D WebGL Canvas */}
      <div
        ref={containerRef}
        onClick={() => rollDice(1.0)}
        className="w-full h-full cursor-pointer active:cursor-grabbing"
      />

      {/* 載入指示器 */}
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-stone-100/90 backdrop-blur-sm transition-opacity">
          <Loader2 className="w-10 h-10 animate-spin text-stone-700 mb-3" />
          <p className="text-sm font-medium text-stone-600">
            載入 3D 物理雙骰中... {progress > 0 ? `${progress}%` : ""}
          </p>
        </div>
      )}

      {/* 頂部功能列：IMU 體感開關與點數結果 */}
      {!loading && (
        <div className="absolute top-4 inset-x-0 flex flex-col items-center pointer-events-none gap-2 px-4 z-20">
          {/* IMU 體感控制按鈕 / 狀態徽章 */}
          <div className="pointer-events-auto">
            {imuSupported && (
              <button
                onClick={toggleIMU}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold shadow-md transition-all duration-200 active:scale-95 ${
                  imuEnabled
                    ? "bg-emerald-600 text-white shadow-emerald-600/30 ring-2 ring-emerald-400"
                    : "bg-white/90 text-stone-700 hover:bg-stone-50 border border-stone-200 backdrop-blur-md"
                }`}
              >
                {imuEnabled ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-emerald-300 animate-ping" />
                    <Vibrate className="w-3.5 h-3.5" />
                    <span>體感已啟用 (搖晃/傾斜)</span>
                  </>
                ) : (
                  <>
                    <Smartphone className="w-3.5 h-3.5 text-indigo-500 animate-pulse" />
                    <span>點擊啟用手機體感 (IMU)</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* 點數結果顯示 (頂部居中徽章) */}
          {rolledNumbers !== null && (
            <div className="animate-in fade-in zoom-in-90 duration-300 pointer-events-none">
              <div className="flex items-center gap-3 px-6 py-2.5 bg-white/95 dark:bg-stone-900/95 backdrop-blur-md rounded-2xl border border-stone-200/90 dark:border-stone-800 shadow-xl">
                <Sparkles className="w-5 h-5 text-amber-500 animate-bounce" />
                <span className="text-xs sm:text-sm font-medium text-stone-500 dark:text-stone-400">點數</span>

                <div className="flex items-center gap-2 font-mono">
                  <span className="px-2.5 py-1 bg-stone-100 dark:bg-stone-800 rounded-lg text-xl sm:text-2xl font-black text-stone-900 dark:text-white border border-stone-200 dark:border-stone-700 shadow-2xs">
                    {rolledNumbers[0]}
                  </span>
                  <span className="text-stone-400 font-bold">+</span>
                  <span className="px-2.5 py-1 bg-stone-100 dark:bg-stone-800 rounded-lg text-xl sm:text-2xl font-black text-stone-900 dark:text-white border border-stone-200 dark:border-stone-700 shadow-2xs">
                    {rolledNumbers[1]}
                  </span>
                  <span className="text-stone-400 font-bold">=</span>
                  <span className="text-2xl sm:text-3xl font-extrabold text-blue-600 dark:text-blue-400 tabular-nums">
                    {rolledNumbers[0] + rolledNumbers[1]}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 左下角即時感測器 HUD (顯示 Z 軸加速度與有效重力 g) */}
      {!loading && (
        <div className="absolute bottom-20 sm:bottom-6 left-4 sm:left-6 pointer-events-auto">
          <div className="flex flex-col gap-1 px-3.5 py-2 bg-white/90 dark:bg-stone-900/90 backdrop-blur-md rounded-2xl border border-stone-200/80 dark:border-stone-800 shadow-md text-xs font-mono select-none">
            <div className="flex items-center justify-between gap-3">
              <span className="text-stone-400">Z軸加速度:</span>
              <span
                className={`font-bold tabular-nums ${
                  accZ < -2
                    ? "text-amber-600 dark:text-amber-400 font-extrabold"
                    : "text-stone-700 dark:text-stone-200"
                }`}
              >
                {accZ >= 0 ? `+${accZ.toFixed(2)}` : accZ.toFixed(2)} m/s²
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-stone-400">有效重力 g:</span>
              <span
                className={`font-bold tabular-nums flex items-center gap-1.5 ${
                  effG < 0
                    ? "text-rose-600 dark:text-rose-400 font-extrabold animate-pulse"
                    : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                <span>{effG.toFixed(2)}G</span>
                {effG < 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-600 border border-rose-500/30 font-sans font-bold">
                    🚀 起飛中
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 輔助按鈕：重置正上方俯視 (精簡置於右下角，不遮擋中央視野) */}
      {!loading && (
        <div className="absolute bottom-20 sm:bottom-6 right-4 sm:right-6 pointer-events-auto">
          <button
            onClick={resetToTopDownView}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-500 hover:text-stone-800 bg-white/80 hover:bg-white/95 backdrop-blur-md rounded-full border border-stone-200/70 shadow-xs transition-all active:scale-95"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置俯視</span>
          </button>
        </div>
      )}
    </div>
  );
}
