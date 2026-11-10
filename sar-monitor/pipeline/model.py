"""Sentinel-1 vessel detector and attribute predictor from Ai2's Skylight team.

The network definitions below are taken, trimmed to what the published Sentinel-1
weights need, from https://github.com/allenai/vessel-detection-sentinels
(Apache License 2.0, Copyright Allen Institute for AI). The layer names must stay as
they are so the published weights load.

Detector: Faster R-CNN on a small convolutional backbone. Input is 2 channels (VH, VV)
of the scene, optionally followed by 2 or 4 channels of earlier images of the same
place, which lets the model ignore things that never move.
Attribute model: ResNet-50 on a 120 x 120 crop around each detection, predicting
length, width, heading (16 buckets), speed and fishing / not fishing.
"""

import hashlib
import json
from collections import OrderedDict
from pathlib import Path

import requests
import torch
import torchvision
from torchvision.models.detection.faster_rcnn import FasterRCNN, FastRCNNPredictor
from torchvision.ops.feature_pyramid_network import FeaturePyramidNetwork, LastLevelMaxPool

from .config import MODELS_DIR

REPO = "allenai/vessel-detection-sentinels"
WEIGHTS = {  # folder -> (sha256, size) of best.pth in the repo's git-lfs storage
    "frcnn_cmp2/3dff445": ("b2b906c1dff8311a50147237a4989766afcc7d1adff34f5ac05afb03dbef6084", 121693810),
    "attr/c34aa37": ("bf86a6e5d8a5705da26effe9ffdf708367cc5e47f27e38d71c2388bd05e03413", 96460157),
}
# The published detector has 11 output classes because the original code counted the
# characters of the string '["vessel"]' instead of the entries. Only class 1 (vessel) was trained.
NUM_CLASSES = 11
VESSEL_LABEL = 1
DETECTOR_DIR = MODELS_DIR / "frcnn_cmp2" / "3dff445"
ATTR_DIR = MODELS_DIR / "attr" / "c34aa37"


class SimpleBackbone(torch.nn.Module):
    def __init__(self, num_channels):
        super().__init__()

        def down_layer(in_channels, out_channels):
            return torch.nn.Sequential(
                torch.nn.Conv2d(in_channels, out_channels, 4, stride=2, padding=1),
                torch.nn.ReLU(inplace=True),
                torch.nn.Conv2d(out_channels, out_channels, 3, padding=1),
                torch.nn.BatchNorm2d(out_channels, eps=1e-3, momentum=0.03),
                torch.nn.ReLU(inplace=True),
            )

        self.down1 = down_layer(num_channels, 32)
        self.down2 = down_layer(32, 64)
        self.down3 = down_layer(64, 128)
        self.down4 = down_layer(128, 256)
        self.down5 = down_layer(256, 512)
        self.features = torch.nn.Sequential(
            torch.nn.Conv2d(512, 512, 3, padding=1),
            torch.nn.ReLU(inplace=True),
            torch.nn.Conv2d(512, 512, 3, padding=1),
            torch.nn.ReLU(inplace=True),
            torch.nn.Conv2d(512, 512, 3, padding=1),
        )

    def forward(self, x):
        down2 = self.down2(self.down1(x))
        down3 = self.down3(down2)
        down4 = self.down4(down3)
        features = self.features(self.down5(down4))
        return {"0": down2, "1": down3, "2": down4, "3": features}


class MyBackbone(torch.nn.Module):
    """Runs the backbone on the current image and on each earlier image, then joins them."""

    def __init__(self, aggregate_op="sum", group_channels=2):
        super().__init__()
        self.aggregate_op = aggregate_op
        self.group_channels = group_channels
        self.backbone = SimpleBackbone(group_channels)
        self.out_channels = 256
        self.fpn = FeaturePyramidNetwork(
            in_channels_list=[128, 256, 512, 1024],
            out_channels=self.out_channels,
            extra_blocks=LastLevelMaxPool(),
        )

    def forward(self, x):
        g = self.group_channels
        base = self.backbone(x[:, 0:g])
        history = {}
        for i in range(g, x.shape[1], g):
            for k, v in self.backbone(x[:, i:i + g]).items():
                if k not in history:
                    history[k] = v
                elif self.aggregate_op == "max":
                    history[k] = torch.maximum(history[k], v)
                else:
                    history[k] = history[k] + v
        out = {}
        for k, v in base.items():
            out[k] = torch.cat([v, history[k] if history else torch.zeros_like(v)], dim=1)
        return self.fpn(out)


class NoopTransform(torch.nn.Module):
    """Batches images without the resizing and normalising torchvision would do."""

    def __init__(self):
        super().__init__()
        self.transform = torchvision.models.detection.transform.GeneralizedRCNNTransform(
            min_size=800, max_size=800, image_mean=[], image_std=[])

    def forward(self, images, targets):
        images = self.transform.batch_images(images, size_divisible=32)
        sizes = [(im.shape[1], im.shape[2]) for im in images]
        return torchvision.models.detection.image_list.ImageList(images, sizes), targets

    def postprocess(self, detections, image_sizes, orig_sizes):
        return detections


class Detector(torch.nn.Module):
    def __init__(self, options: dict, image_size: int):
        super().__init__()
        scale = image_size * image_size // 800 // 800
        self.backbone = MyBackbone(
            aggregate_op=options.get("AggregateOp", "sum"),
            group_channels=options.get("GroupChannels", 2),
        )
        self.faster_rcnn = FasterRCNN(
            self.backbone,
            NUM_CLASSES,
            min_size=image_size,
            max_size=image_size,
            box_detections_per_img=max(100, 100 * scale),
            rpn_pre_nms_top_n_test=max(1000, 1000 * scale),
            rpn_post_nms_top_n_test=max(1000, 1000 * scale),
        )
        in_features = self.faster_rcnn.roi_heads.box_predictor.cls_score.in_features
        self.faster_rcnn.roi_heads.box_predictor = FastRCNNPredictor(in_features, NUM_CLASSES)
        self.faster_rcnn.transform = NoopTransform()

    def forward(self, images: list[torch.Tensor]) -> list[dict]:
        """images: float tensors (channels, H, W) scaled 0..1. Returns boxes and scores per image."""
        image_list, _ = self.faster_rcnn.transform(images, None)
        features = self.faster_rcnn.backbone(image_list.tensors)
        if isinstance(features, torch.Tensor):
            features = OrderedDict([("0", features)])
        proposals, _ = self.faster_rcnn.rpn(image_list, features)
        detections, _ = self.faster_rcnn.roi_heads(features, proposals, image_list.image_sizes)
        return detections


class AttributeModel(torch.nn.Module):
    def __init__(self, num_channels: int = 2):
        super().__init__()
        self.resnet = torchvision.models.resnet.resnet50(weights=None)
        self.resnet.conv1 = torch.nn.Conv2d(
            num_channels, self.resnet.conv1.out_channels, kernel_size=7, stride=2, padding=3, bias=False)
        self.resnet.fc = torch.nn.Sequential(
            torch.nn.Linear(self.resnet.fc.in_features, 256),
            torch.nn.ReLU(),
            torch.nn.Linear(256, 1 + 1 + 16 + 1 + 2),  # length, width, heading buckets, speed, fishing
        )

    def forward(self, crops: torch.Tensor) -> torch.Tensor:
        return self.resnet(crops)


def ensure_weights() -> None:
    """Download the published weights (about 220 MB) if they are not on disk yet."""
    for folder, (oid, size) in WEIGHTS.items():
        target = MODELS_DIR / folder
        target.mkdir(parents=True, exist_ok=True)
        cfg = target / "cfg.json"
        if not cfg.exists():
            url = f"https://raw.githubusercontent.com/{REPO}/main/data/model_artifacts/sentinel-1/{folder}/cfg.json"
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            cfg.write_bytes(r.content)
        weights = target / "best.pth"
        if weights.exists() and weights.stat().st_size == size:
            continue
        print(f"downloading weights {folder} ({size / 1e6:.0f} MB)")
        batch = requests.post(
            f"https://github.com/{REPO}.git/info/lfs/objects/batch",
            headers={"Accept": "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json"},
            json={"operation": "download", "transfers": ["basic"], "objects": [{"oid": oid, "size": size}]},
            timeout=60,
        )
        batch.raise_for_status()
        href = batch.json()["objects"][0]["actions"]["download"]["href"]
        data = requests.get(href, timeout=600).content
        if hashlib.sha256(data).hexdigest() != oid:
            raise RuntimeError(f"checksum mismatch for {folder}")
        weights.write_bytes(data)


def load(device: torch.device, window_size: int) -> tuple[Detector, AttributeModel]:
    ensure_weights()
    options = json.loads((DETECTOR_DIR / "cfg.json").read_text())["Options"]
    detector = Detector(options, window_size)
    detector.load_state_dict(torch.load(DETECTOR_DIR / "best.pth", map_location="cpu", weights_only=True))
    attr = AttributeModel()
    attr.load_state_dict(torch.load(ATTR_DIR / "best.pth", map_location="cpu", weights_only=True))
    return detector.to(device).eval(), attr.to(device).eval()
