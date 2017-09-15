import './base-lineage-plot.css'
import angular from 'angular'

let d3 = Object.assign({},
    require('d3-selection'),
    require('d3-selection-multi'),
    require('d3-format'),
    require('d3-xyzoom'),
    require('d3-scale'),
    require('d3-array'),
    require('d3-axis'),
    require('d3-brush')
);

d3.getEvent = () => require('d3-selection').event;

import { d3legend, d3tooltip, mergeTemplateLayout, createNodeTypes, LabelCollisionDetection,
    spreadGenerations, createDynamicNodeAttr, scaleProperties, drawColorBar, calcColorBarSize, allocatePaddingInScale,
    testLabelLength, getTranslation, createPlotControls, attachActionOnResize, getBBox, filterSeries, getClipUniqueId,
    toggleSelectionDisplay, skipProperties, getLinkLabelBBox, getNodeLabelBBox, getDomainLength, almostEq}
    from '../shared-features.js'

class BaseLineagePlotController {
    constructor($element, $window, $scope, $attrs) {
        this._$window = $window;
        this._$element = $element;
        this._$scope = $scope;
        this._$attrs = $attrs;

        attachActionOnResize($window, () => {
            this.axisSvgs = {};
            this.initializeData({isNewData: false});
            this.render({});
        });
        $element.addClass('ancestry');

        this.svg = d3.select($element[0])
            .style('position', 'relative')
            .append('svg');
        this.defaultPalette = d3.scaleOrdinal(d3.schemeCategory10);
        this.maxAllowedDepth = 180;
        this.mouseStart = null;
        this.selectionRect = null;
        this.tooltip = new d3tooltip(d3.select($element[0]));
        this.defaultNode = {
            r: 4,
            'stroke-width': 2
        };
        this.selectedNodesSet = new Set();
        this.activeControls = null;
        this.LCD = null;
        this.LCDUpdateID = null;
        this.heatmapColorScale = null;
        this.heatmapCircle = d3.select();
        this.colorBarOffset = 0;
        this.visibleSeries = new Set();
        this.axisSvgs = {};
        this.transform = d3.xyzoomIdentity;

        this.onZoom = this.onZoom.bind(this);
        this.linkGenerator = this.linkGenerator.bind(this);
        this.onDoubleClick = this.onDoubleClick.bind(this);
        this.toggleZoom = this.toggleZoom.bind(this);
        this.toggleSelect = this.toggleSelect.bind(this);
        this.toggleLabels = this.toggleLabels.bind(this);
        this.toggleBrush = this.toggleBrush.bind(this);
        this.toggleRotate = this.toggleRotate.bind(this);

        this.originAtCenter = false;
    }

    initializeData(options = {isNewData: true}) {
        this.data = angular.copy(this.plotData);
        this.layout = mergeTemplateLayout(this.plotLayout, this.constructor.getLayoutTemplate());

        let longestNodeName = this.data.length ? this.data.reduce((a, b) =>
                a.name.length > b.name.length ? a : b).name : '';
        this.maxLabelSize = testLabelLength(this.svg, longestNodeName, this.layout.nodeLabel);
        this.maxLabelOffset = {
                x: d3.max(this.layout.nodeLabelPositions, (pos) => Math.abs(pos.x)),
                y: d3.max(this.layout.nodeLabelPositions, (pos) => Math.abs(pos.y))
            };

        let elementWidth = this._$element[0].offsetWidth,
            elementHeight = this._$element[0].offsetHeight,
            margin = this.layout.margin;

        this.margin = margin;
        this.width = (this.layout.width || elementWidth);
        this.height = (this.layout.height || elementHeight);
        this.plotWidth = this.width - margin.right - margin.left;
        this.plotHeight = this.height - margin.top - margin.bottom;

        if (this.originAtCenter) {
            let minDim = Math.min(this.plotHeight, this.plotWidth);
            this.plotWidth = minDim / 2 + this.maxLabelSize.width + this.maxLabelOffset.x;
            this.plotHeight = minDim / 2;
        }

        this.realPlotWidth = this.originAtCenter ? 2 * this.plotWidth : this.plotWidth;
        this.realPlotHeight = this.originAtCenter ? 2 * this.plotHeight : this.plotHeight;


        this.viewport = [[this.originAtCenter ? -this.plotWidth : 0, this.originAtCenter ? -this.plotHeight : 0],
            [this.plotWidth, this.plotHeight]];

        this.heightWithBrush = this.margin.top + this.plotHeight + this.margin.bottom +
            this.layout.brush.margin.bottom + this.layout.brush.margin.top + this.layout.brush.height;


        this.seriesNames = Array.from(new Set(this.data.map(d => d.series)));

        if (options.isNewData) {
            this.visibleSeries = new Set(this.seriesNames);
        }

        if (this.activeControls == null) {
            this.hiddenControls = new Set(Object.entries(this.layout.controls)
                .filter(([name, config]) => !config.show).map(([name, config]) => name));
            this.activeControls = new Set(Object.entries(this.layout.controls)
                .filter(([name, config]) => config.show && config.active).map(([name, config]) => name));
        }
        this.lcdEnabled = this.layout.labelCollisionDetection.enabled != 'never' && this.activeControls.has('label');

        this.colors = (series) => {
            return (series in this.layout.seriesColors) ? this.layout.seriesColors[series] :
                this.defaultPalette(series);
        };

        let types = createNodeTypes(this.data, this.layout.nodeTypes, this.defaultNode);
        this.nodeAttr = createDynamicNodeAttr(types, Object.keys(this.defaultNode));
        let filteredData = filterSeries(this.data, this.visibleSeries);
        this.lastData = angular.copy(filteredData);

        this.isTimePlot = filteredData[0].date != undefined;

        this.nodes = this.prepareNodes(filteredData);

        if (!options.isNewData) {
            this.nodes.forEach(d => {
                d.data.selected = this.selectedNodesSet.has(d.data.name);
            })
        } else {
            this.selectedNodesSet = new Set();
            this.nodes.filter(d => d.data.selected).forEach(d => {
                this.selectedNodesSet.add(d.data.name);
            })
        }

        this.nodeLabelData = this.nodes.map(d => {
            return {node: d, currentLabelPos: this.layout.nodeLabelPositions[0], dy: this.layout.nodeLabel.dy};
        });
        this.linkLabelData = this.nodes
            .filter(d => d.parent.data.name != 'virtualRoot' && d.data.inLinkLabel != null)
            .map(d => {
                return {nodeTo: d, dy: this.layout.linkLabel.dy};
            });

        this.setupScales();
        this.adjustScales();

        this._xScale = this.xScale.copy();
        this._yScale = this.yScale.copy();

        this.heatmapColorScale = this.createHeatmapColorScale(filteredData);

        this.updatePositions();
    }

    static getLayoutTemplate() {
        return new Error('Improper use of abstract class!');
    }

    //noinspection JSMethodCanBeStatic
    linkGenerator() {
        return new Error('Improper use of abstract class!');
    }

    // overridden method should define class members: xScale, yScale and xExtent
    //noinspection JSMethodCanBeStatic
    setupScales() {
        return new Error('Improper use of abstract class!');
    }

    adjustScales() {
        let paddingX = this.layout.plotPadding.x,
            paddingY = this.layout.plotPadding.y;

        if (paddingX == null || paddingY == null) {
            if (paddingX == null) {
                paddingX = this.maxLabelSize.width + this.maxLabelOffset.x + 5;
            }
            if (paddingY == null) {
                paddingY = this.maxLabelSize.height + this.maxLabelOffset.y + 5;
            }
        }

        if (paddingX > 0) {
            this.xScale = allocatePaddingInScale(this.xScale, paddingX);
        }

        if (paddingY > 0) {
            this.yScale = allocatePaddingInScale(this.yScale, paddingY);
        }
    }

    $onChanges(changes) {
        if ((changes.plotData && changes.plotData.currentValue) ||
            (changes.plotLayout && changes.plotLayout.currentValue)) {
            this.initializeData();
            this.render();
        }
    }

    render() {
        this.svg.selectAll('*').remove();
        this.svg.attr('width', this.width)
            .attr('height', this.height);

        this.svg.append('rect')
            .attrs({
                x: 0,
                y: 0,
                width: this.width,
                height: this.heightWithBrush,
                'stroke-width': 0,
                fill: this.layout.backgroundColor
            });

        this.defs = this.svg.append('defs');

        let clipRectId = `clip-rect${getClipUniqueId()}`;
        this.defs.append('svg:clipPath')
            .datum(clipRectId)
            .attr('id', clipRectId)
            .append('svg:rect')
            .attr('x', this.viewport[0][0])
            .attr('y', this.viewport[0][1])
            .attr('width', this.realPlotWidth)
            .attr('height', this.realPlotHeight);

        this.defs.append('marker')
            .attrs({
                id: 'marker-arrowhead',
                viewBox: '0 -5 10 10',
                refX: 15,
                refY: 0,
                markerWidth: 8,
                markerHeight: 8,
                orient: 'auto'
            })
            .append('path')
            .attr('d', 'M0,-4L10,0L0,4')
            .attr('fill', this.layout.link.stroke)
            .attr('class','arrowHead');

        this.treeFixedContainer = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left + (this.width - this.margin.right - this.margin.left) / 2
                }, ${this.margin.top + (this.height - this.margin.top - this.margin.bottom) / 2})`);

        this.mouseRect = this.treeFixedContainer.append('rect')
            .attr('id', 'mouse-capture')
            .attr('x', this.viewport[0][0])
            .attr('y', this.viewport[0][1])
            .attr('width', this.realPlotWidth)
            .attr('height', this.realPlotHeight)
            .style('fill', 'transparent');

        this.makeZoom();
        this.drawColorBar();
        this.drawLegend();
        this.drawMainAxes();
        this.drawTitle();

        this.treeContainer = this.treeFixedContainer.append('g')
            .attr('clip-path', `url(${this._$window.location.pathname}#${clipRectId})`);

        this.drawTrees();

        this.makeNodeSelection();
        this.makeLCD();
        this.makeBrush();
        this.makeTooltip();

        this.makeControlPanel();
        this.zoomToMinimumWidth();

        if (this.layout.textColor) { // set global text color
            this.svg.selectAll('text').attr('fill', this.layout.textColor);
        }

        this.afterRender();
    }

    updateAndRedraw() {
        this.drawMainAxes();
        this.updatePositions();
        this.drawLinks(false);
        this.drawNodes(false);
        this.applyLCD();
    }

    //noinspection JSMethodCanBeStatic
    afterRender() {
        // pass
    }

    //noinspection JSMethodCanBeStatic
    prepareNodes(/* data */) {
        return new Error('Improper use of abstract class!');
    }

    drawTrees(redraw = true) {
        if (redraw) {
            this.treeContainer.selectAll('*').remove();
        }
        this.drawLinks(redraw);
        this.drawNodes(redraw);
        this.linkLabelLayer.moveToFront();
    }

    drawNodes(redraw=true) {

        if (this.layout.heatmap.enabled && redraw) {

            this.heatmapCircle = this.treeContainer.append('g')
                .attr('class', 'heatmap-layer')
                .selectAll('circle.heatmap-circle')
                .data(this.nodes.filter(n => !isNaN(parseFloat(n.data.z))))
                .enter()
                .append('circle')
                .attr('class', 'heatmap-circle')
                .style('fill', d => this.heatmapColorScale(d.data.z))
                .style('opacity', this.layout.heatmap.opacity)
                .attrs(this.layout.heatmap.circle);
        }

        if (redraw) {
            this.marker = this.treeContainer.append('g')
                .attr('class', 'node-marker-layer')
                .selectAll('circle.node-marker')
                .data(this.nodes)
                .enter();

            if (this._$attrs.customNode) {
                this.marker = this.customNode({$selection: this.marker, $event: 'draw'});
            } else {
                this.marker = this.marker.append('circle')
                    .attr('class', 'node-marker')
                    .style('fill', d => d.data.selected ? this.colors(d.data.series) : '#FFF')
                    .style('stroke', d => this.colors(d.data.series))
                    .attrs(this.nodeAttr);
            }

            this.nodeLabel = this.treeContainer.append('g')
                .attr('class', 'node-label-layer')
                .selectAll('text.node-label')
                .data(this.nodeLabelData)
                .enter()
                .append('text')
                .attr('class', 'node-label')
                .text(d => d.node.data.name)
                .style('opacity', this.activeControls.has('label') ? 1 : 1e-6)
                .each(getNodeLabelBBox)
                .attr('text-anchor', d => d.currentLabelPos['text-anchor'])
                .attrs(skipProperties(this.layout.nodeLabel, 'dy'));
        }

        if (this._$attrs.customNode) {
            this.customNode({$selection: this.marker, $event: 'update'});
        } else {
            this.marker.attr('cx', d => d.x)
                .attr('cy', d => d.y);
        }

        this.heatmapCircle.attr('cx', d => d.x)
            .attr('cy', d => d.y);

        this.nodeLabel.attr('x', d => d.x)
            .attr('y', d => d.y);
    }

    //noinspection JSMethodCanBeStatic
    drawMainAxes() {
        return new Error('Improper use of abstract class!');
    }

    //noinspection JSMethodCanBeStatic
    drawBrushAxes() {
        return new Error('Improper use of abstract class!');
    }

    drawAxis(container, type, scale, tickLength, isTimeAxis=false, fixTicks=false) {
        let axisType = null, isMain = null,
            axisSvg = `axis-${type}-svg`;

        [axisType, isMain] = type.split('-');
        isMain = isMain == 'main';

        let layout = (isMain ? this.layout.axis : this.layout.brush.axis)[axisType],
            axis = (axisType == 'x' ? d3.axisBottom : d3.axisLeft)()
                .scale(scale)
                .tickSizeInner(0)
                .tickSizeOuter(0);

        if (axisType == 'x' && !isTimeAxis && fixTicks) {
            let [start, end] = this.xScale.domain();
            start = Math.max(Math.ceil(start), this.xExtent[0]);
            end = Math.min(Math.floor(end), this.xExtent[1]);
            axis.tickFormat(d3.format('d'))
                .tickValues(d3.range(start, end + 1));
        }

        if (!this.axisSvgs[axisSvg]) {
            this.axisSvgs[axisSvg] = container.append('g')
                .attr('transform', `translate(0, ${axisType == 'x' ? tickLength : 0})`)
                .attr('class', `axis ${type}`);

            this.axisSvgs[axisSvg].call(axis);
            let offset = this.axisSvgs[axisSvg].node().getBBox()[axisType == 'x' ? 'height' : 'width'];

            if (layout.title) {
                let range = Math.abs(scale.range()[1] - scale.range()[0]),
                    width = axisType == 'x' ? range : tickLength,
                    height = axisType == 'x' ? tickLength : range;

                container.append('text')
                    .attr('class', 'axis-title')
                    .style('text-anchor', 'middle')
                    .attr('transform', axisType == 'x' ? '' : 'rotate(-90)')
                    .text(layout.title)
                    .attrs({
                        x: axisType == 'x' ? width / 2 : -height / 2,
                        y: axisType == 'x' ? height + offset + 15 : -offset - 10
                    });
            }
        }

        axis.tickSizeInner(layout.showGrid ? -tickLength : 0);
        this.axisSvgs[axisSvg].call(axis);
        BaseLineagePlotController.adjustAxisStyles(this.axisSvgs[axisSvg], layout);
    }

    static adjustAxisStyles(axis, layout) {
        axis.selectAll('.domain').style('opacity', layout.showAxisLine ? 1 : 1e-6);

        if (layout.showGrid) {
            axis.selectAll('.tick line')
                .attr('stroke', '#ccc')
                .style('shape-rendering', 'crispEdges');
        } else {
            axis.selectAll('.tick line').style('opacity', 1e-6);
        }

        if (layout.showTickText) {
            axis.selectAll('.tick text').attr('font-size', 12);
        } else {
            axis.selectAll('.tick text').style('opacity', 1e-6);
        }
    }

    zoomToMinimumWidth() {
        if (!this.layout.minViewportWidth) return;
        let ratio;
        if (!this.isTimePlot) {
            let generationWidth = this.xScale.range()[1] / getDomainLength(this.xScale);
            ratio = this.layout.minViewportWidth.generationWidth / generationWidth;
        } else {
            let pixelsPerSecond = this.xScale.range()[1] / getDomainLength(this.xScale) * 1000;
            ratio = this.layout.minViewportWidth.timeIntervalInPixels /
                this.layout.minViewportWidth.timeIntervalInSeconds / pixelsPerSecond;
        }

        if (ratio > 1) {
            this.treeFixedContainer.call(this.zoom.transform, d3.xyzoomIdentity.scale(ratio, 1).translate(0, 0));
        }
    }

    drawLinks(redraw = true) {
        if (redraw) {
            this.link = this.treeContainer.append('g')
                .attr('class', 'link-layer')
                .selectAll('path.link')
                .data(this.nodes.filter(n => n.parent.data.name != 'virtualRoot'))
                .enter()
                .insert('path', 'g')
                .attr('class', 'link')
                .attr('marker-end', this.layout.showLinkArrowhead ?
                    `url(${this._$window.location.pathname}#marker-arrowhead)` : '')
                .attrs(this.layout.link);

            this.linkLabelLayer = this.treeContainer.append('g')
                .attr('class', 'link-label-layer');

            this.linkLabel = this.linkLabelLayer
                .selectAll('text.link-label')
                .data(this.linkLabelData)
                .enter()
                .append('text')
                .attr('class', 'link-label')
                .attr('text-anchor', 'middle')
                .text(d => d.nodeTo.data.inLinkLabel)
                .style('opacity', this.activeControls.has('label') ? 1 : 1e-6)
                .each(getLinkLabelBBox)
                .attrs(skipProperties(this.layout.linkLabel, 'dy'));
        }

        this.link.attr('d', this.linkGenerator);
        this.linkLabel.attr('x', d => d.x)
            .attr('y', d => d.y);
    }

    drawLegend() {
        if (!this.layout.legend.show) return;

        let that = this,
            x = this.layout.legend.x,
            y = this.layout.legend.y,
            anchor = this.layout.legend.anchor,
            orientation = this.layout.legend.orientation,
            splitAfter = orientation === 'horizontal' ? 0 : 1,
            totalWidth = this.realPlotWidth + this.colorBarOffset;

        function legendClick(/*d, i, all*/) {
            let d = arguments[0],
                all = d3.selectAll(arguments[2]);
            if (that.visibleSeries.has(d.label)) {
                that.visibleSeries.delete(d.label);
                if (!that.visibleSeries.size) {
                    all.each(d => {
                        d.active = true;
                        that.visibleSeries.add(d.label);
                    });
                }
            } else {
                that.visibleSeries.add(d.label);
            }
            all.classed('legend-item-selected', d => that.visibleSeries.has(d.label));
            all.selectAll('rect.shape')
                .attr('fill', d => that.visibleSeries.has(d.label) ? that.colors(d.label) : 'white');
            that.initializeData({isNewData: false});
            that.drawMainAxes();
            that.drawTrees();
            that.makeBrush();
            that.treeFixedContainer.call(that.zoom.transform, d3.xyzoomIdentity); // TODO: transitions don't work properly with d3-xyzoom (.transition().duration(750))
            that.makeLCD();
            that.makeTooltip();
        }

        let drawLegend = d3legend()
            .splitAfter(splitAfter)
            .anchor(anchor)
            .seriesNames(this.seriesNames)
            .colorScale(this.colors)
            .backgroundColor(this.layout.legend.backgroundColor || this.layout.backgroundColor)
            .maxSize({width: totalWidth, height: this.realPlotHeight})
            .onClick(legendClick)
            .selectedItems(this.visibleSeries);

        this.svg.append('g')
            .attr('transform',
            `translate(${this.margin.left + x * totalWidth},${this.margin.top + y * this.realPlotHeight})`)
            .attr('class', 'ancestry-legend')
            .call(drawLegend);
    }

    createHeatmapColorScale(nodes) {
        let domain = d3.extent(nodes, node => node.z);

        if (domain[0] == domain[1]) {
            if (domain[0] === undefined) {
                domain[0] = domain[1] = 0;
            }
            domain[0] -= 0.5;
            domain[1] += 0.5;
        }

        return d3.scaleLinear()
            .domain(domain)
            .range(this.layout.heatmap.colorScale.map(v => v[1]));
    }

    drawColorBar() {
        if (!this.layout.heatmap.enabled || !this.layout.heatmap.colorBar.show) return;

        this.layout.heatmap.colorBar.height = calcColorBarSize(this.layout.heatmap.colorBar.height,
            this.plotHeight);
        this.layout.heatmap.colorBar.width = calcColorBarSize(this.layout.heatmap.colorBar.width, this.realPlotWidth);

        let colorBar = this.treeFixedContainer.append('g')
            .attr('class', 'ancestry-colorbar')
            .attr('transform', `translate(${this.plotWidth + this.layout.heatmap.colorBar.padding.left},${
            this.plotHeight / 2})`);

        drawColorBar(colorBar, this.heatmapColorScale.domain(), this.layout.heatmap, this.defs,
            this._$window.location.pathname);

        this.colorBarOffset = colorBar.node().getBBox().width + this.layout.heatmap.colorBar.padding.left +
            this.layout.heatmap.colorBar.padding.right;
    }

    makeTooltip() {
        if (!this.layout.tooltip.show) return;
        let that = this;

        this.marker.on('mouseover', function (d) {
            let x = 0, y = 0; // split into 2 lines to avoid WebStorm warning
            ({x, y} = d3tooltip.getRelativePosition(this, that._$element[0]));
            let seriesBar = that.layout.tooltip.showSeriesBar ?
                `<div class='tooltip-color-box' style=\'background-color: ${that.colors(d.data.series)}\'>` +
                '</div>' : '',
                text = d.data.tooltip ? d.data.tooltip.map((line) => {
                        return `<span align='${that.layout.tooltip.align}' class='tooltip-text'>${line}</span>`;
                    }).join('') : `<span class='tooltip-text'>${d.data.name}</span>`;

            that.tooltip.html(seriesBar + text).position([x, y]).show();
        })
        .on('mouseout', () => {
            this.tooltip.hide();
        });
    }

    updatePositions() {
        for (let node of this.nodes) {
            node.x = this.xScale(this.isTimePlot ? node._x.getTime() : node._x);
            node.y = this.yScale(node._y);
        }

        for (let node of this.nodeLabelData) {
            node.x = node.node.x + node.currentLabelPos.x;
            node.y = node.node.y + node.currentLabelPos.y + node.dy;
        }

        for (let node of this.linkLabelData) {
            node.x = (node.nodeTo.x + node.nodeTo.parent.x) / 2;
            node.y = (node.nodeTo.y + node.nodeTo.parent.y) / 2 + node.dy;
        }
    }

    makeLCD() {
        if (this.layout.labelCollisionDetection.enabled === 'never') return;

        let order = [[], []];

        order[this.layout.labelCollisionDetection.order.nodeLabel - 1].push(this.nodeLabel);
        order[this.layout.labelCollisionDetection.order.linkLabel - 1].push(this.linkLabel);

        this.makeBBox();
        this.LCD = new LabelCollisionDetection([this.marker], order, this.layout.nodeLabelPositions,
            this.viewport, this.markerBBoxes);

        if (this.activeControls.has('label')) {
            this.LCD.recalculateLabels();
        }
    }

    makeZoom() {
        this.zoom = d3.xyzoom()
            .extent(this.viewport)
            .scaleExtent([[1, Infinity], [1, Infinity]])
            .translateExtent(this.viewport)
            .on('zoom', this.onZoom);
    }

    onDoubleClick() {
        this.xScale = this._xScale.copy();
        this.yScale = this._yScale.copy();
        this.treeFixedContainer.call(this.zoom.transform, d3.xyzoomIdentity);
        this.updateAndRedraw();
    }

    onZoom() {
        let event = d3.getEvent();

        this.transform = event.transform;
        this.xScale = this.transform.rescaleX(this._xScale);
        this.yScale = this.transform.rescaleY(this._yScale);
        this.updateAndRedraw();

        if (event.sourceEvent && (event.sourceEvent.type === 'brush' || event.sourceEvent.type === 'end')) return;

        let [x1, x2] = this.xScale.domain().map(this.xScaleBrush),
            [y1, y2] = this.yScale.domain().map(this.yScaleBrush);

        this.brushContainer.call(this.brush.move, this.layout.brush.lockY ? [x1, x2] : [[x1, y1], [x2, y2]]);
    }

    applyLCD(transform) {
        if (!this.lcdEnabled) return;

        if (this.layout.labelCollisionDetection.enabled === 'onEveryChange') {
            this.LCD.recalculateLabels(transform);
        }
        else if (this.layout.labelCollisionDetection.enabled === 'onDelay') {
            window.clearTimeout(this.LCDUpdateID);
            this.LCDUpdateID = window.setTimeout(() => {
                this.LCD.recalculateLabels(transform);
            }, this.layout.labelCollisionDetection.updateDelay);
        }
    }

    makeControlPanel() {
        let controls = skipProperties({
                'download': function () {},
                'zoom': this.toggleZoom,
                'rotate': this.toggleRotate,
                'brush': this.toggleBrush,
                'select': this.toggleSelect,
                'label': this.toggleLabels
            }, Array.from(this.hiddenControls));

        createPlotControls(this._$element[0], controls, this.activeControls);
    }

    makeNodeSelection() {
        let that = this,
            mouseStart = null;

        // expose click for toggleSelect
        this.onNodeClick = onNodeClick;

        if (!this.layout.groupSelection.enabled) return;

        this.selectionRect = this.treeFixedContainer.append('rect')
            .attr('class', 'selection-rect')
            .attrs(this.layout.groupSelection.selectionRectangle);

        // expose mouse down for toggleSelect
        this.mouseDown = mouseDown;

        function onNodeClick(d) {
            d.data.selected = !d.data.selected;
            let node = d3.select(this);
            if (that._$attrs.customNode) {
                that.customNode({$selection: node, $event: 'select'});
            } else {
                node.style('fill', d => d.data.selected ? that.colors(d.data.series) : '#FFF');
            }
            updateSelection();
        }

        function updateSelection() {
            let newSelected = new Set(that.marker.filter(d => d.data.selected).data().map(d => d.data.name)),
                wasChange = newSelected.size != that.selectedNodesSet.size ||
                    (new Set([...that.selectedNodesSet].filter(x => !newSelected.has(x))).size != 0);

            if (wasChange) {
                that.selectedNodesSet = newSelected;
                if (that._$attrs.nodesSelection) {
                    that._$scope.$apply(() => {
                        that.nodesSelection({$nodes: Array.from(that.selectedNodesSet)});
                    });
                }
            }
        }

        function finalizeSelection() {
            that.selectionRect.attr('width', 0);
            updateSelection();
            that.marker.style('pointer-events', 'all');
            that.mouseRect.on('mousemove', null)
                .on('mouseup', null)
                .on('mouseout', null);
        }

        function mouseDown() {
            d3.getEvent().preventDefault();
            mouseStart = d3.mouse(that.mouseRect.node());
            that.mouseRect.on('mousemove', mouseMove)
                .on('mouseup', finalizeSelection)
                .on('mouseout', finalizeSelection);
            that.marker.each(d => {
                d._selected = d.data.selected;
            }).style('pointer-events', 'none');
        }

        function mouseMove() {
            let p = d3.mouse(that.mouseRect.node());
            let d = {
                x: (p[0] < mouseStart[0] ? p[0] : mouseStart[0]),
                y: (p[1] < mouseStart[1] ? p[1] : mouseStart[1]),
                height: Math.abs(p[1] - mouseStart[1]),
                width: Math.abs(p[0] - mouseStart[0])
            };
            that.selectionRect.attrs(d);
            selectPoints(that.selectionRect);
        }

        function selectPoints(rect) {
            let rect_x1 = +rect.attr('x'), rect_y1 = +rect.attr('y'),
                rect_x2 = +rect.attr('width') + rect_x1, rect_y2 = +rect.attr('height') + rect_y1;

            let [inSelection, outSelection] =
                that.marker.partition(d => d.x >= rect_x1 && d.x <= rect_x2 && d.y >= rect_y1 && d.y <= rect_y2);

            inSelection.each(d => {
                d.data.selected = true
            });
            outSelection.each(d => {
                d.data.selected = d._selected
            });
            if (that._$attrs.customNode) {
                that.customNode({$selection: that.marker, $event: 'select'});
            } else {
                that.marker.style('fill', d => d.data.selected ? that.colors(d.data.series) : '#FFF');
            }
        }
    }

    drawTitle() {
        if (this.layout.title) {
            this.treeFixedContainer.append('text')
                .attr('x', this.originAtCenter ? 0 : this.plotWidth / 2)
                .attr('y', -10)
                .attr('text-anchor', 'middle')
                .style('font-size', '20px')
                .text(this.layout.title);
        }
    }

    toggleZoom(toggle) {
        if (toggle) {
            this.treeFixedContainer.call(this.zoom)
                .on('dblclick.zoom', this.onDoubleClick);
        }
        else {
            this.treeFixedContainer.on('wheel.zoom', null)
                .on('mousedown.zoom', null)
                .on('dblclick.zoom', null)
                .on('touchstart.zoom', null)
                .on('touchmove.zoom', null)
                .on('touchend.zoom', null)
                .on('touchcancel.zoom', null);
        }
    }

    toggleSelect(toggle) {
        let that = this;

        if (this.layout.groupSelection.enabled) {
            this.mouseRect.on('mousedown', toggle ? this.mouseDown : null);
        }

        toggleNodeClickCallback();

        function toggleNodeClickCallback() {
            function nodeClickCallback(d) {
                that._$scope.$apply(() => {
                    that.nodeClick({$event: d3.getEvent(), $node: d.data});
                });
            }

            that.marker.on('click', toggle ? that.onNodeClick : (that._$attrs.nodeClick ? nodeClickCallback : null));
        }
    }

    toggleRotate(toggle) {
        let that = this,
            start = null;
        if (toggle) {
            //this.treeFixedContainer.call(this.zoom)
            //    .on('dblclick.zoom', this.onDoubleClick);
            this.treeFixedContainer
                .on("mousedown", function () {
                    that.svg.style("cursor", "move");
                    start = that.transform.invert(d3.mouse(that.treeContainer.node()));
                })
                .on("mouseup", mouseOutUp)
                .on("mouseout", mouseOutUp)
                .on("mousemove", function () {
                    if (start) {
                        let m = that.transform.invert(d3.mouse(that.treeContainer.node())),
                            delta = Math.atan2(cross(start, m), dot(start, m)) * 180 / Math.PI;

                        for (let node of that.nodes) {
                            node._theta = node._lastTheta + delta;
                            [node._x, node._y] = project(node);
                        }
                        that.updateAndRedraw();
                    }
                });
        }
        else {
            this.treeFixedContainer.on('mousedown', null)
                .on('mouseup', null)
                .on('mousemove', null)
                .on('mouseout', null);
        }

        function mouseOutUp() {
            start = null;
            for (let node of that.nodes) {
                node._lastTheta = node._theta;
            }
            that.svg.style("cursor", "auto");
        }
    }

    toggleLabels(toggle) {
        if (this.layout.labelCollisionDetection.enabled != 'never' &&
            this.layout.labelCollisionDetection.enabled != 'onInit') {
            this.lcdEnabled = toggle;
            if (this.lcdEnabled) {
                this.LCD.recalculateLabels();
            }
        }
        this.nodeLabel.style('opacity', d => toggle && !d.isColliding ? 1 : 1e-6);
        this.linkLabel.style('opacity', d => toggle && !d.isColliding ? 1 : 1e-6);
    }

    makeBBox() {

        let testNodeLabel = this.svg.append('text').text('yT'),
            testLinkLabel = this.svg.append('text').text('yT');

        testNodeLabel.attrs(this.layout.nodeLabel);
        testLinkLabel.attrs(this.layout.linkLabel);

        let nodeLabelHeight = testNodeLabel.node().getBBox().height,
            linkLabelHeight = testLinkLabel.node().getBBox().height;

        testNodeLabel.remove();
        testLinkLabel.remove();

        let canvas = document.createElement('canvas');
        let context = canvas.getContext('2d');

        context.font = `${this.layout.nodeLabel['font-size']}px ${this.layout.nodeLabel['font-family']}`;

        this.nodeLabel.each(d => {
            d.width = context.measureText(d.node.data.name).width;
            d.height = nodeLabelHeight;
            getNodeLabelBBox(d);
        });

        context.font = `${this.layout.linkLabel['font-size']}px ${this.layout.linkLabel['font-family']}`;

        this.linkLabel.each(d => {
            d.width = context.measureText(d.nodeTo.data.inLinkLabel).width;
            d.height = linkLabelHeight;
            getLinkLabelBBox(d);
        });

        let nodeTypes = this.nodes.map(d => d.data.type),
            uniqueNodeTypes = new Set(nodeTypes),
            markerBBoxes = {};

        for (let type of uniqueNodeTypes) {
            let node = this.marker.filter(d => d.data.type == type).node(),
                bbox = node.getBBox();

            markerBBoxes[type] = {width: bbox.width, height: bbox.height}
        }

        this.markerBBoxes = markerBBoxes;
    }

    toggleBrush(active) {
        this.svg.attr('height', active ? this.heightWithBrush : this.height);
        this.brushFixedContainer.style('display', active ? 'inline' : 'none')
    }

    makeBrush() {
        if (this.brushFixedContainer) { // remove brush if already exists
            this.brushFixedContainer.remove();
            this.svg.select('.brush-clip').remove();
        }

        let brushNodes = this.prepareNodes(this.lastData),
            brushHeight = this.layout.brush.height,
            fullExtent = [[0, 0], [this.plotWidth, brushHeight]],
            brushMarginTop = this.layout.brush.margin.top,
            lockY = this.layout.brush.lockY,
            that = this;

        this.brushHeight = brushHeight;
        this.xScaleBrush = this.xScale.copy();
        this.yScaleBrush = this.yScale.copy().range([0, brushHeight]);

        for (let node of brushNodes) {
            node.x = this.xScaleBrush(this.isTimePlot ? node._x.getTime() : node._x);
            node.y = this.yScaleBrush(node._y);
        }

        let clipRectId = `clip-rect${getClipUniqueId()}`;
        this.defs.append('svg:clipPath')
            .attr('class', 'brush-clip')
            .datum(clipRectId)
            .attr('id', clipRectId)
            .append('svg:rect')
            .attrs({
                x: -1,
                y: -1,
                width: this.plotWidth + 3,
                height: brushHeight + 3
            })
            .attrs(this.layout.brush.boxRectangle);

        this.brushFixedContainer = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left}, ${this.margin.top + this.plotHeight + brushMarginTop})`);

        this.drawBrushAxes();

        this.brushContainer = this.brushFixedContainer.append('g')
            .attr('clip-path', `url(${this._$window.location.pathname}#${clipRectId})`);

        if (this.layout.brush.drawTrees) {
            this.brushContainer.append('g')
                .attr('class', 'link-layer')
                .selectAll('path.link')
                .data(brushNodes.filter(n => n.parent.data.name != 'virtualRoot'))
                .enter()
                .insert('path', 'g')
                .attr('class', 'link')
                .attr('marker-end', this.layout.showLinkArrowhead ?
                    `url(${this._$window.location.pathname}#marker-arrowhead)` : '')
                .attr('d', this.linkGenerator)
                .attrs(this.layout.link);

            let brushMarker = this.brushContainer.append('g')
                .attr('class', 'node-marker-layer')
                .selectAll('circle.node-marker')
                .data(brushNodes)
                .enter();

            if (that._$attrs.customNode) {
                this.customNode({$selection: brushMarker, $event: 'draw'});
            } else {
                brushMarker.append('circle')
                    .attr('class', 'node-marker')
                    .style('fill', 'white')
                    //.style('fill', d => d.data.selected ? this.colors(d.data.series) : '#FFF')
                    .style('stroke', d => this.colors(d.data.series))
                    .attr('cx', d => d.x)
                    .attr('cy', d => d.y)
                    .attrs(this.nodeAttr);
            }
        }

        this.brushFixedContainer.append('rect')
            .attr('fill', 'none')
            .style('shape-rendering', 'crispEdges')
            .attr('x', -1)
            .attr('y', -1)
            .attr('width', this.plotWidth + 2)
            .attr('height', brushHeight + 2)
            .attrs(this.layout.brush.boxRectangle);

        this.brush = (lockY ? d3.brushX : d3.brush)()
            .extent(fullExtent)
            .on('brush end', brushed);

        this.brushContainer
            .call(this.brush)
            .call(this.brush.move, null);

        this.toggleBrush(that.activeControls.has('brush'));

        function isFullView(s) {
            return lockY ? almostEq(s[0], 0) && almostEq(s[1], that.plotWidth) :
                (almostEq(s[0][0], 0) && almostEq(s[0][1], 0) && almostEq(s[1][0], that.plotWidth) &&
                almostEq(s[1][1], brushHeight));
        }

        function brushed() {
            let event = d3.getEvent(),
                s = event.selection;

            if ((!s && that.layout.brush.brushRectangleOnFullView)) {
                that.brushContainer
                    .call(that.brush.move, lockY ? [0, that.plotWidth] : fullExtent);
                return;
            } else if (!that.layout.brush.brushRectangleOnFullView && s && isFullView(s)) {
                that.brushContainer
                    .call(that.brush.move, null);
                return;
            }

            let sx = s != null ? (lockY ? [s[0], s[1]] : [s[0][0], s[1][0]]) : that.xScaleBrush.range(),
                sy = s != null ? (lockY ? [0, brushHeight] : [s[0][1], s[1][1]]) : that.yScaleBrush.range(),
                dx1 = sx.map(that.xScaleBrush.invert, that.xScaleBrush), dx2 = that._xScale.domain(),
                dy1 = sy.map(that.yScaleBrush.invert, that.yScaleBrush), dy2 = that._yScale.domain(),
                kx = (dx2[1] - dx2[0]) / (dx1[1] - dx1[0]),
                ky = (dy2[1] - dy2[0]) / (dy1[1] - dy1[0]),
                newTransform = d3.xyzoomIdentity
                    .scale(kx, ky)
                    .translate(-sx[0], -that._yScale(that.yScaleBrush.invert(sy[0])));

            if (isFinite(kx) && isFinite(ky)) {
                that.treeFixedContainer.call(that.zoom.transform, newTransform);
            }
        }
    }
}

d3.selection.prototype.moveToFront = function () {
    return this.each(function () {
        //noinspection JSCheckFunctionSignatures
        this.parentNode.appendChild(this);
    });
};

d3.selection.prototype.moveToBack = function() {
    return this.each(function() {
        let firstChild = this.parentNode.firstChild;
        if (firstChild) {
            //noinspection JSCheckFunctionSignatures
            this.parentNode.insertBefore(this, firstChild);
        }
    });
};

BaseLineagePlotController.$$ngIsClass = true; // temporary Firefox fix

export default BaseLineagePlotController;


function cross(a, b) { return a[0] * b[1] - a[1] * b[0]; }

function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

function project(d) {
    let a = (d._theta - 90) / 180 * Math.PI;
    return [d._r * Math.cos(a), d._r * Math.sin(a)];
}